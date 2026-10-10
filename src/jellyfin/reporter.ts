import type { JfContext } from "./context";
import { jfRaw } from "./http";
import type { PlaybackPlan } from "./playback";
import { secToTicks } from "./ticks";

/**
 * Meldet Wiedergabe und Fortschritt an Jellyfin ("Weiterschauen", "Gesehen"). Fehler dürfen die Wiedergabe nie stören:
 * jede Anfrage ist abgesichert, nichts davon wirft oder bleibt als unbehandelte Ablehnung liegen.
 *
 * Mit einem API-Key (statt Benutzer-Anmeldung) hat die Sitzung auf dem Server keinen Benutzer – `/Sessions/Playing*`
 * speichert dann nichts. Position und Gesehen-Status gehen deshalb direkt über die Benutzerdaten
 * (`POST /UserItems/{id}/UserData`, `POST /UserPlayedItems/{id}`); die Sitzungsmeldungen laufen nur "nebenbei" mit
 * (sie halten u. a. die Umwandlung am Leben und zeigen die Wiedergabe im Server-Dashboard).
 */

/** Ab diesem Anteil der Laufzeit gilt ein Titel als gesehen (statt als "angefangen"). */
export const PLAYED_RATIO = 0.92;
/** Wie in der XMB (src/xmb/progress.ts): kürzere Positionen werden nicht als Weiterschauen-Stand gespeichert. */
export const MIN_RESUME_SEC = 10;
/** Mindestabstand zwischen zwei regulären Fortschrittsmeldungen. */
export const PROGRESS_INTERVAL_MS = 10_000;
/** Ein Sprung um mehr als so viele Sekunden gegenüber der erwarteten Position zählt als Spulen und wird sofort gemeldet. */
const SEEK_JUMP_SEC = 3;
/** Zeitlimit je Meldung – lieber verwerfen als die Oberfläche (oder das Beenden) aufhalten. */
const REQUEST_TIMEOUT_MS = 6000;

export interface ReporterOptions {
  /** Abstand der regulären Meldungen (Standard {@link PROGRESS_INTERVAL_MS}). */
  intervalMs?: number;
  /** Zeitquelle in Millisekunden (für Tests). */
  now?: () => number;
}

/** Was nach dem Beenden auf dem Server steht. */
export interface StopResult {
  /** Als gesehen gemeldet. */
  played: boolean;
  /** Gespeicherte Weiterschauen-Position in Sekunden (0 = keine). */
  resumeSec: number;
}

/* ----------------------------------------------- Pfade je Serverversion merken */

type Variant = "new" | "legacy";

/**
 * Welche Pfad-Variante der Server kennt – je Server gemerkt, damit nicht bei jeder Meldung erst ein 404 kommt.
 * Neu: `/UserItems/{id}/UserData`, `/UserPlayedItems/{id}`. Alt (bis 10.8): `/Users/{userId}/Items/{id}/UserData`,
 * `/Users/{userId}/PlayedItems/{id}`.
 */
const known = new Map<string, { userData?: Variant; played?: Variant }>();

/** Nur zum Prüfen/Zurücksetzen (Tests). */
export function resetReporterMemory(): void {
  known.clear();
}

function remember(base: string, what: "userData" | "played", variant: Variant) {
  known.set(base, { ...known.get(base), [what]: variant });
}

/** POST mit Rückfall auf den älteren Pfad bei 404/405; true = der Server hat es angenommen. */
async function postWithFallback(
  ctx: JfContext,
  what: "userData" | "played",
  paths: Record<Variant, { path: string; query?: Record<string, string> }>,
  body?: unknown,
): Promise<boolean> {
  const first = known.get(ctx.base)?.[what];
  const order: Variant[] = first === "legacy" ? ["legacy", "new"] : ["new", "legacy"];
  for (const variant of order) {
    const { path, query } = paths[variant];
    try {
      const res = await jfRaw(ctx, path, { method: "POST", query, body, timeoutMs: REQUEST_TIMEOUT_MS });
      if (res.ok) {
        remember(ctx.base, what, variant);
        return true;
      }
      // Nur "gibt es nicht"/"falsche Methode" heißt: andere Serverversion. Alles andere (401, 500 …) ändert der andere Pfad nicht.
      if (res.status !== 404 && res.status !== 405) return false;
    } catch {
      return false;
    }
  }
  return false;
}

/* ------------------------------------------------------------------- Bericht */

export class PlaybackReporter {
  private plan: PlaybackPlan;
  private readonly interval: number;
  private readonly now: () => number;

  private started = false;
  private stopped = false;
  /** Letzte gemeldete Stelle (für Drosselung und Sprungerkennung); sentAt 0 = noch nichts gemeldet. */
  private sentAt = 0;
  private sentPos = 0;
  private sentPaused = false;
  /** Aktuelle Werte des Players. */
  private pos = 0;
  private paused = false;
  /** Zuletzt auf dem Server gespeicherte Position in Ticks; null = unbekannt. */
  private savedTicks: number | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly ctx: JfContext,
    plan: PlaybackPlan,
    opts: ReporterOptions = {},
  ) {
    this.plan = plan;
    this.interval = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    // Was als Weiterschauen-Stand schon auf dem Server liegt, weiß die Planung.
    this.savedTicks = plan.resumeSec > 0 ? secToTicks(plan.resumeSec) : null;
  }

  /** Die Wiedergabe beginnt (Position `positionSec`, Standard: Startposition des Plans). Wirft nie. */
  async start(positionSec?: number): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    const pos = this.clean(positionSec ?? this.plan.startSec);
    this.pos = pos;
    this.markSent(pos, false);
    await this.session("Playing", pos, false);
  }

  /**
   * Meldet die aktuelle Position (darf mehrmals pro Sekunde aufgerufen werden, z. B. bei `timeupdate`). Gesendet wird
   * höchstens alle ~10 s – sofort aber bei Pause/Fortsetzen und beim Spulen. Gibt nichts zurück und wirft nie.
   */
  progress(positionSec: number, paused: boolean): void {
    if (this.stopped || !Number.isFinite(positionSec)) return;
    const pos = this.clean(positionSec);
    this.pos = pos;
    this.paused = paused;
    if (!this.started) void this.start(pos);
    const elapsedMs = this.now() - this.sentAt;
    const expected = this.sentPos + (this.sentPaused ? 0 : elapsedMs / 1000);
    const due =
      this.sentAt === 0 ||
      paused !== this.sentPaused ||
      Math.abs(pos - expected) > SEEK_JUMP_SEC ||
      elapsedMs >= this.interval;
    if (due) this.flush();
  }

  /**
   * Die Wiedergabe endet: Position bzw. "gesehen" speichern, Umwandlung beenden, Server benachrichtigen.
   * `ended` = bis zum Ende gelaufen. Wartet höchstens auf die Antworten des Servers (mit Zeitlimit), wirft nie.
   */
  async stop(positionSec: number, ended: boolean): Promise<StopResult> {
    const pos = Number.isFinite(positionSec) ? this.clean(positionSec) : this.pos;
    if (this.stopped) return { played: false, resumeSec: this.savedTicks ? this.savedTicks / 10_000_000 : 0 };
    this.stopped = true;
    const duration = this.plan.durationSec;
    const played = ended || (duration > 0 && pos / duration >= PLAYED_RATIO);

    // Eine noch laufende Fortschrittsmeldung soll vor dem Endstand ankommen, nicht danach.
    if (this.inFlight) await Promise.race([this.inFlight, new Promise<void>((r) => setTimeout(r, 1500))]);

    const tasks: Promise<unknown>[] = [
      played ? this.markPlayed() : this.savePosition(pos),
      this.session("Playing/Stopped", pos, false),
      stopEncoding(this.ctx, this.plan),
    ];
    await Promise.allSettled(tasks);
    return { played, resumeSec: played || !this.savedTicks ? 0 : this.savedTicks / 10_000_000 };
  }

  /**
   * Nach einer neuen Planung (Tonspur gewechselt, Einbrennen …): ab jetzt gilt der neue Plan. Die Umwandlung des alten
   * wird beendet; die nächste Fortschrittsmeldung geht sofort raus.
   */
  replacePlan(plan: PlaybackPlan): void {
    const old = this.plan;
    this.plan = plan;
    this.sentAt = 0;
    void stopEncoding(this.ctx, old);
  }

  /* ------------------------------------------------------------- intern */

  /** Auf sinnvolle Werte begrenzen: nicht negativ, nicht über die Laufzeit. */
  private clean(sec: number): number {
    const max = this.plan.durationSec > 0 ? this.plan.durationSec : Infinity;
    return Math.min(Math.max(0, Number.isFinite(sec) ? sec : 0), max);
  }

  private markSent(pos: number, paused: boolean) {
    this.sentAt = this.now() || 1;
    this.sentPos = pos;
    this.sentPaused = paused;
  }

  /** Eine Meldung nach der anderen; was während einer laufenden Meldung anfällt, wird danach einmal nachgeholt. */
  private flush(): void {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    const pos = this.pos;
    const paused = this.paused;
    this.markSent(pos, paused);
    this.inFlight = Promise.allSettled([this.session("Playing/Progress", pos, paused), this.savePosition(pos)])
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.flush();
        }
      });
  }

  /** `/Sessions/Playing[/Progress|/Stopped]` – nur nebenbei (siehe Kopf), Antwort egal. */
  private async session(kind: "Playing" | "Playing/Progress" | "Playing/Stopped", posSec: number, paused: boolean): Promise<void> {
    const p = this.plan;
    const body: Record<string, unknown> = {
      ItemId: p.itemId,
      MediaSourceId: p.mediaSourceId,
      PlaySessionId: p.playSessionId,
      PositionTicks: secToTicks(posSec),
    };
    if (kind === "Playing/Stopped") {
      body.Failed = false;
    } else {
      body.PlayMethod = p.method;
      body.CanSeek = true;
      body.IsPaused = paused;
      body.IsMuted = false;
      body.RepeatMode = "RepeatNone";
      if (p.audioIndex !== null) body.AudioStreamIndex = p.audioIndex;
      if (p.subtitleIndex !== null) body.SubtitleStreamIndex = p.subtitleIndex;
    }
    try {
      await jfRaw(this.ctx, `/Sessions/${kind}`, { method: "POST", body, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch {
      // bewusst ignoriert
    }
  }

  /** Speichert die Weiterschauen-Position (oder löscht einen alten Stand, wenn von vorn begonnen wurde). */
  private async savePosition(posSec: number): Promise<void> {
    let ticks = secToTicks(posSec);
    if (posSec < MIN_RESUME_SEC) {
      // Am Anfang nichts merken – nur einen vorhandenen Stand zurücksetzen.
      if (!this.savedTicks) return;
      ticks = 0;
    }
    if (ticks === this.savedTicks) return;
    const ok = await postWithFallback(
      this.ctx,
      "userData",
      {
        new: { path: `/UserItems/${encodeURIComponent(this.plan.itemId)}/UserData`, query: { userId: this.ctx.userId } },
        legacy: { path: `/Users/${encodeURIComponent(this.ctx.userId)}/Items/${encodeURIComponent(this.plan.itemId)}/UserData` },
      },
      // LastPlayedDate gehört dazu: danach sortiert Jellyfin "Weiterschauen" (die Sitzungsmeldungen setzen es sonst).
      { PlaybackPositionTicks: ticks, LastPlayedDate: new Date().toISOString() },
    );
    if (ok) this.savedTicks = ticks;
  }

  private async markPlayed(): Promise<void> {
    const id = encodeURIComponent(this.plan.itemId);
    const ok = await postWithFallback(this.ctx, "played", {
      new: { path: `/UserPlayedItems/${id}`, query: { userId: this.ctx.userId } },
      legacy: { path: `/Users/${encodeURIComponent(this.ctx.userId)}/PlayedItems/${id}` },
    });
    // "Gesehen" setzt auf dem Server auch die Position zurück.
    if (ok) this.savedTicks = 0;
  }
}

/** `DELETE /Videos/ActiveEncodings`: beendet die Umwandlung dieser Sitzung auf dem Server. Fehler sind egal. */
async function stopEncoding(ctx: JfContext, plan: PlaybackPlan): Promise<void> {
  if (plan.method === "DirectPlay" || !plan.playSessionId) return;
  try {
    await jfRaw(ctx, "/Videos/ActiveEncodings", {
      method: "DELETE",
      query: { deviceId: plan.deviceId, playSessionId: plan.playSessionId },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch {
    // bewusst ignoriert
  }
}

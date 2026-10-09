import { sheetCount, sheetRange, slotAt } from "../jellyfin/trickplay";
import type { TrickplayInfo } from "../jellyfin/trickplay";
import type { PlaybackPlan } from "../jellyfin/playback";

/*
 * Vorschaubilder für die Zeitleiste. Zwei Quellen mit derselben Schnittstelle:
 *  - TrickplaySource: die Kachelbilder des Jellyfin-Servers (src/jellyfin/trickplay.ts), erst bei Bedarf geladen.
 *  - LocalPreviewSource: ohne Server-Trickplay (z. B. Demo) ein verstecktes zweites <video> auf dieselbe Datei, das
 *    träge an die Zielstelle springt und ein kleines Bild aufnimmt. Läuft nie hörbar und nie auf dem Hauptelement.
 * Die Anzeige (Preview.tsx) fragt nur frameAt() und zeigt es per CSS-Hintergrund.
 */

/** Ein Bild bzw. ein Ausschnitt eines Kachelbilds, zusammen mit seiner Lage. */
export interface PreviewFrame {
  url: string;
  /** Größe des Bilds in Vorschaubildern (Kachelbild 10 × 10; ein einzelnes Bild 1 × 1) und Lage des gewünschten. */
  cols: number;
  rows: number;
  col: number;
  row: number;
  /** false = noch nicht das gewünschte, sondern das nächstliegende vorhandene Bild. */
  exact: boolean;
}

export interface PreviewSource {
  readonly kind: "trickplay" | "local";
  /** Breite / Höhe eines Vorschaubilds. */
  readonly aspect: number;
  /** Es kommt keine Vorschau zustande (Server liefert nichts, Video lässt sich nicht lesen) – dann nur die Zeit zeigen. */
  readonly failed: boolean;
  /** Das beste jetzt vorhandene Bild zur Zeit; null, solange noch keines da ist. */
  frameAt(sec: number): PreviewFrame | null;
  /** Der Nutzer steht bei `sec`: Bild laden bzw. aufnehmen (träge, Überholtes wird verworfen). */
  want(sec: number): void;
  /** Der Nutzer hört auf zu spulen: nichts Neues mehr anfangen. */
  idle(): void;
  /** Meldet, wenn ein neues Bild vorliegt oder sich `aspect`/`failed` ändern. */
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

class Listeners {
  private readonly set = new Set<() => void>();
  add(fn: () => void): () => void {
    this.set.add(fn);
    return () => this.set.delete(fn);
  }
  fire() {
    for (const fn of Array.from(this.set)) fn();
  }
  clear() {
    this.set.clear();
  }
}

/** Das Bild ist dekodiert und kann ohne Aussetzer gezeichnet werden. */
function decoded(img: HTMLImageElement): Promise<void> {
  return typeof img.decode === "function" ? img.decode().catch(() => undefined) : Promise.resolve();
}

/* ------------------------------------------------------------------ Trickplay */

/** So viele Kachelbilder bleiben höchstens im Speicher (jedes ist dekodiert mehrere MB groß). */
const MAX_SHEETS = 5;
/** Ein fehlgeschlagenes Kachelbild wird frühestens nach dieser Zeit erneut angefragt. */
const SHEET_RETRY_MS = 4000;

interface Sheet {
  url: string;
  img: HTMLImageElement | null;
  state: "loading" | "ready" | "error";
  cols: number;
  rows: number;
  used: number;
  failedAt: number;
}

export class TrickplaySource implements PreviewSource {
  readonly kind = "trickplay" as const;
  readonly aspect: number;
  private readonly sheets = new Map<number, Sheet>();
  private readonly listeners = new Listeners();
  private tick = 0;
  private errors = 0;
  private disposed = false;
  private wantedSheet = 0;

  constructor(
    private readonly info: TrickplayInfo,
    /** Adresse des Kachelbilds Nr. n (mit Anmeldung). */
    private readonly urlOf: (sheet: number) => string,
  ) {
    this.aspect = info.width / info.height;
  }

  get failed(): boolean {
    return this.errors > 0 && ![...this.sheets.values()].some((s) => s.state === "ready");
  }

  subscribe(fn: () => void): () => void {
    return this.listeners.add(fn);
  }

  frameAt(sec: number): PreviewFrame | null {
    const want = slotAt(this.info, sec);
    const exact = this.sheets.get(want.sheet);
    if (exact?.state === "ready") {
      exact.used = ++this.tick;
      return { url: exact.url, cols: exact.cols, rows: exact.rows, col: want.col, row: want.row, exact: true };
    }
    // Das gewünschte Kachelbild fehlt noch: das nächstliegende Bild aus einem vorhandenen zeigen.
    let best: { sheet: Sheet; thumb: number; dist: number } | null = null;
    for (const [n, sheet] of this.sheets) {
      if (sheet.state !== "ready") continue;
      const [lo, hi] = sheetRange(this.info, n);
      const thumb = Math.min(hi, Math.max(lo, want.thumb));
      const dist = Math.abs(thumb - want.thumb);
      if (!best || dist < best.dist) best = { sheet, thumb, dist };
    }
    if (!best) return null;
    const perSheet = this.info.tileWidth * this.info.tileHeight;
    const within = best.thumb % perSheet;
    return {
      url: best.sheet.url,
      cols: best.sheet.cols,
      rows: best.sheet.rows,
      col: within % this.info.tileWidth,
      row: Math.floor(within / this.info.tileWidth),
      exact: false,
    };
  }

  want(sec: number): void {
    if (this.disposed) return;
    this.wantedSheet = slotAt(this.info, sec).sheet;
    this.ensure(this.wantedSheet);
    if (this.sheets.get(this.wantedSheet)?.state === "ready") this.prefetchAround();
  }

  idle(): void {
    // Kachelbilder lassen sich nicht sinnvoll abbrechen und sind gleich wieder gefragt.
  }

  dispose(): void {
    this.disposed = true;
    for (const sheet of this.sheets.values()) {
      if (sheet.img) {
        sheet.img.onload = null;
        sheet.img.onerror = null;
      }
    }
    this.sheets.clear();
    this.listeners.clear();
  }

  /** Das gerade gewünschte Kachelbild ist da: die Nachbarn vorladen (Spulen geht meist in eine Richtung weiter). */
  private prefetchAround() {
    this.ensure(this.wantedSheet + 1);
    this.ensure(this.wantedSheet - 1);
  }

  private ensure(n: number) {
    if (this.disposed || n < 0 || n >= sheetCount(this.info)) return;
    const cur = this.sheets.get(n);
    if (cur && (cur.state !== "error" || Date.now() - cur.failedAt < SHEET_RETRY_MS)) {
      cur.used = ++this.tick;
      return;
    }
    const img = new Image();
    const sheet: Sheet = {
      url: this.urlOf(n),
      img,
      state: "loading",
      cols: this.info.tileWidth,
      rows: this.info.tileHeight,
      used: ++this.tick,
      failedAt: 0,
    };
    this.sheets.set(n, sheet);
    img.onload = () => {
      void decoded(img).then(() => {
        if (this.disposed || this.sheets.get(n) !== sheet) return;
        // Maße aus dem Bild selbst: ein verkürztes letztes Kachelbild hat weniger Zeilen.
        sheet.cols = Math.max(1, Math.round(img.naturalWidth / this.info.width));
        sheet.rows = Math.max(1, Math.round(img.naturalHeight / this.info.height));
        sheet.state = "ready";
        this.listeners.fire();
        if (n === this.wantedSheet) this.prefetchAround();
      });
    };
    img.onerror = () => {
      if (this.disposed || this.sheets.get(n) !== sheet) return;
      sheet.state = "error";
      sheet.failedAt = Date.now();
      this.errors += 1;
      this.listeners.fire();
    };
    img.src = sheet.url;
    this.trim();
  }

  private trim() {
    while (this.sheets.size > MAX_SHEETS) {
      let oldest: number | null = null;
      for (const [n, s] of this.sheets) {
        if (n === this.wantedSheet) continue;
        if (oldest === null || s.used < (this.sheets.get(oldest)?.used ?? Infinity)) oldest = n;
      }
      if (oldest === null) return;
      const gone = this.sheets.get(oldest);
      if (gone?.img) {
        gone.img.onload = null;
        gone.img.onerror = null;
      }
      this.sheets.delete(oldest);
    }
  }
}

/* ---------------------------------------------------------------- Lokal erzeugt */

/** Breite der aufgenommenen Bilder in Pixeln. */
const THUMB_WIDTH = 320;
const THUMB_QUALITY = 0.72;
/** So viele aufgenommene Bilder bleiben höchstens im Speicher (je etwa 10–20 kB). */
const MAX_CELLS = 360;
/** Wartezeit, bis nach der letzten Zielangabe aufgenommen wird: schnelle Tastenwiederholung soll nicht jede Stelle anfahren. */
const CAPTURE_DELAY_MS = 70;
const SEEK_TIMEOUT_MS = 6000;
/** Nach so vielen Fehlschlägen in Folge ohne ein einziges Bild gibt die Quelle auf. */
const MAX_FAILURES = 3;

/** Abstand der aufgenommenen Bilder: bei kurzen Clips dichter, bei langen Filmen weiter. */
export function localInterval(durationSec: number): number {
  return durationSec <= 90 ? 2 : durationSec <= 1800 ? 5 : 10;
}

/** Ein Plan, bei dem die Datei so wie sie ist im Browser lesbar ist (nicht HLS, nicht vom Server umgewandelt). */
export function canPreviewLocally(plan: PlaybackPlan): boolean {
  return plan.protocol === "file" && plan.method !== "Transcode" && plan.durationSec > 0;
}

interface Cell {
  url: string;
  used: number;
}

export class LocalPreviewSource implements PreviewSource {
  readonly kind = "local" as const;
  private _aspect: number;
  private _failed = false;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly cells = new Map<number, Cell>();
  private readonly listeners = new Listeners();
  private readonly interval: number;
  private readonly lastCell: number;
  private target: number | null = null;
  private timer = 0;
  private busy = false;
  private ready = false;
  private failures = 0;
  private tick = 0;
  private disposed = false;
  private url: string;

  constructor(url: string, private readonly durationSec: number, aspect = 16 / 9) {
    this.url = url;
    this._aspect = aspect > 0 ? aspect : 16 / 9;
    this.interval = localInterval(durationSec);
    this.lastCell = Math.max(0, Math.floor(Math.max(0, durationSec - 0.1) / this.interval));
    this.canvas = document.createElement("canvas");
    const v = document.createElement("video");
    v.muted = true;
    v.defaultMuted = true;
    v.volume = 0;
    v.playsInline = true;
    v.preload = "metadata";
    v.crossOrigin = "anonymous";
    v.disablePictureInPicture = true;
    v.setAttribute("aria-hidden", "true");
    v.tabIndex = -1;
    // Außerhalb des Bilds, aber im Dokument: manche WebViews dekodieren sonst keine Bilder zum Abgreifen.
    v.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    v.addEventListener("loadedmetadata", this.onMeta);
    v.addEventListener("error", this.onError);
    this.video = v;
    document.body.appendChild(v);
    v.src = url;
  }

  get aspect(): number {
    return this._aspect;
  }

  get failed(): boolean {
    return this._failed;
  }

  subscribe(fn: () => void): () => void {
    return this.listeners.add(fn);
  }

  /** Dieselbe Datei unter einer anderen Adresse (nach dem Umstellen der Wiedergabe): aufgenommene Bilder bleiben. */
  retarget(url: string): void {
    if (this.disposed || url === this.url) return;
    this.url = url;
    this.ready = false;
    this.failures = 0;
    this.setFailed(false);
    this.video.src = url;
  }

  frameAt(sec: number): PreviewFrame | null {
    if (this.cells.size === 0) return null;
    const want = this.cellOf(sec);
    let hit = this.cells.get(want);
    let exact = true;
    if (!hit) {
      exact = false;
      let bestDist = Infinity;
      for (const [n, cell] of this.cells) {
        const dist = Math.abs(n - want);
        if (dist < bestDist) {
          bestDist = dist;
          hit = cell;
        }
      }
    }
    if (!hit) return null;
    hit.used = ++this.tick;
    return { url: hit.url, cols: 1, rows: 1, col: 0, row: 0, exact };
  }

  want(sec: number): void {
    if (this.disposed || this._failed) return;
    const cell = this.cellOf(sec);
    this.target = cell;
    if (!this.cells.has(cell)) this.schedule(CAPTURE_DELAY_MS);
  }

  idle(): void {
    this.target = null;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.timer);
    const v = this.video;
    v.removeEventListener("loadedmetadata", this.onMeta);
    v.removeEventListener("error", this.onError);
    v.removeAttribute("src");
    try {
      v.load();
    } catch {
      // bewusst ignoriert
    }
    v.remove();
    for (const cell of this.cells.values()) URL.revokeObjectURL(cell.url);
    this.cells.clear();
    this.listeners.clear();
  }

  private cellOf(sec: number): number {
    const c = Math.round((Number.isFinite(sec) ? Math.max(0, sec) : 0) / this.interval);
    return Math.min(this.lastCell, c);
  }

  private setFailed(value: boolean) {
    if (this._failed === value) return;
    this._failed = value;
    this.listeners.fire();
  }

  private readonly onMeta = () => {
    const v = this.video;
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      const aspect = v.videoWidth / v.videoHeight;
      if (Math.abs(aspect - this._aspect) > 0.01) {
        this._aspect = aspect;
        this.listeners.fire();
      }
    }
    this.ready = true;
    if (this.target !== null && !this.cells.has(this.target)) this.schedule(0);
  };

  private readonly onError = () => {
    if (!this.video.getAttribute("src")) return; // Leeren der Quelle löst selbst einen Fehler aus
    this.ready = false;
    if (this.cells.size === 0) this.setFailed(true);
  };

  private schedule(ms: number) {
    if (this.timer || this.busy || this.disposed) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.pump();
    }, ms);
  }

  private async pump(): Promise<void> {
    const cell = this.target;
    if (this.disposed || this.busy || this._failed || cell === null || this.cells.has(cell)) return;
    if (!this.ready) return; // onMeta stößt es an
    this.busy = true;
    try {
      await this.capture(cell);
    } finally {
      this.busy = false;
    }
    // Der Nutzer ist inzwischen weitergezogen: das neue Ziel, nicht die alte Stelle.
    if (!this.disposed && this.target !== null && !this.cells.has(this.target)) this.schedule(20);
  }

  /** Springt an die Stelle der Zelle und nimmt das Bild auf. */
  private capture(cell: number): Promise<void> {
    const v = this.video;
    const limit = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : this.durationSec;
    // Nie genau 0: ein Sprung auf die schon eingestellte Stelle löst kein "seeked" aus.
    const at = Math.min(Math.max(0.05, cell * this.interval), Math.max(0.05, limit - 0.1));
    return new Promise<void>((resolve) => {
      let done = false;
      let timeout = 0;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        window.clearTimeout(timeout);
        v.removeEventListener("seeked", onSeeked);
        v.removeEventListener("error", onFail);
        if (!ok) {
          this.failures += 1;
          if (this.failures >= MAX_FAILURES && this.cells.size === 0) this.setFailed(true);
          resolve();
          return;
        }
        void this.store(cell).then(resolve);
      };
      const onSeeked = () => finish(v.readyState >= 2);
      const onFail = () => finish(false);
      v.addEventListener("seeked", onSeeked);
      v.addEventListener("error", onFail);
      timeout = window.setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
      try {
        v.currentTime = at;
      } catch {
        finish(false);
      }
    });
  }

  /** Das gerade eingestellte Bild verkleinert in den Zwischenspeicher legen. */
  private async store(cell: number): Promise<void> {
    const v = this.video;
    if (this.disposed || v.videoWidth === 0 || v.videoHeight === 0) return;
    const w = THUMB_WIDTH;
    const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
    const c = this.canvas;
    c.width = w;
    c.height = h;
    try {
      c.getContext("2d")?.drawImage(v, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", THUMB_QUALITY));
      if (!blob || this.disposed) return;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await decoded(img);
      if (this.disposed) {
        URL.revokeObjectURL(url);
        return;
      }
      this.failures = 0;
      this.cells.set(cell, { url, used: ++this.tick });
      this.trim(cell);
      this.listeners.fire();
    } catch {
      // Ein "verschmutzter" Canvas (Quelle ohne CORS) lässt sich nicht auslesen: dann gibt es hier keine Vorschau.
      if (this.cells.size === 0) this.setFailed(true);
    }
  }

  private trim(keep: number) {
    while (this.cells.size > MAX_CELLS) {
      let oldest: number | null = null;
      for (const [n, cell] of this.cells) {
        if (n === keep) continue;
        if (oldest === null || cell.used < (this.cells.get(oldest)?.used ?? Infinity)) oldest = n;
      }
      if (oldest === null) return;
      const gone = this.cells.get(oldest);
      if (gone) URL.revokeObjectURL(gone.url);
      this.cells.delete(oldest);
    }
  }
}

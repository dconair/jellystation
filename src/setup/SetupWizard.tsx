import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { biosDirOf } from "../emulators/requirements";
import { useEmulators } from "../emulators/useEmulators";
import { useRequirements } from "../emulators/useRequirements";
import { useControllerProbe } from "../input/useControllerProbe";
import { useGamepad } from "../input/useGamepad";
import type { PadAction } from "../input/useGamepad";
import { isValidServerUrl, normalizeServerUrl, testJellyfin } from "../jellyfin/testConnection";
import type { ConnectionResult } from "../jellyfin/testConnection";
import { saveSettings } from "../settings/settings";
import type { Settings } from "../settings/settings";
import { PsSymbol } from "../ui/PsSymbol";
import type { PsSymbolName } from "../ui/PsSymbol";
import { Background } from "../xmb/Background";
import { playSfx } from "../xmb/sound";
import { runChecks } from "./checks";
import type { CheckResult } from "./checks";
import { CheckStep, ControllerStep, FilesStep, GamesStep, JellyfinStep } from "./steps";
import type { Draft } from "./steps";
import "./setup.css";

interface SetupWizardProps {
  /** Vorhandene Einstellungen (beim erneuten Ausführen). */
  initial?: Settings | null;
  onComplete: (settings: Settings) => void;
  /** Nur gesetzt, wenn bereits eine Konfiguration existiert. */
  onCancel?: () => void;
}

const STEPS: { symbol: PsSymbolName; title: string }[] = [
  { symbol: "triangle", title: "Jellyfin" },
  { symbol: "circle", title: "Spiele" },
  { symbol: "cross", title: "Dateien" },
  { symbol: "square", title: "Controller" },
  { symbol: "triangle", title: "Prüfung" },
];
const STEP_FILES = 2;
const STEP_CONTROLLER = 3;
const STEP_CHECK = 4;

/** Alles, was sich per Steuerkreuz anwählen lässt (Reihenfolge = DOM-Reihenfolge). */
const FOCUSABLE = "input:not([disabled]), button:not([disabled])";

interface HintProps {
  symbol: PsSymbolName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}

/** Tastenhinweis der Fußzeile: PlayStation-Symbol + Beschriftung, klickbar wie die Taste selbst. */
function Hint({ symbol, label, onClick, disabled, primary }: HintProps) {
  return (
    <button
      type="button"
      className={`ps-btn ps-btn--hint${primary ? " ps-btn--primary" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <PsSymbol symbol={symbol} size="1.7rem" />
      <span>{label}</span>
    </button>
  );
}

export function SetupWizard({ initial, onComplete, onCancel }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({
    url: initial?.jellyfin.url ?? "",
    apiKey: initial?.jellyfin.apiKey ?? "",
    gamesDir: initial?.gamesDir ?? "",
    biosDir: initial?.biosDir ?? "",
  });
  const emulators = useEmulators(initial?.emulators);
  const requirements = useRequirements(biosDirOf(draft.biosDir));
  const [test, setTest] = useState<{ busy: boolean; result: ConnectionResult | null }>({
    busy: false,
    result: null,
  });
  const [results, setResults] = useState<CheckResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [runId, setRunId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const probe = useControllerProbe(true);
  const probeName = useRef(probe.name);
  probeName.current = probe.name;

  // Nummer des laufenden Tests: Wird während der Prüfung die Adresse oder der Schlüssel geändert, gilt das
  // späte Ergebnis nicht mehr – sonst stünde "Verbunden" neben einer Adresse, die gar nicht getestet wurde.
  const testSeq = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const patch = useCallback((p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    // Nur eine inhaltliche Änderung macht das Testergebnis ungültig. Das Aufräumen der Adresse beim Verlassen
    // des Felds ("host:8096" → "http://host:8096") nicht – sonst verschwände das Ergebnis, sobald man per
    // Steuerkreuz weiterwandert.
    const prev = draftRef.current;
    const changed =
      (p.url !== undefined && normalizeServerUrl(p.url) !== normalizeServerUrl(prev.url)) ||
      (p.apiKey !== undefined && p.apiKey.trim() !== prev.apiKey.trim());
    if (changed) {
      testSeq.current++;
      setTest({ busy: false, result: null });
    }
  }, []);

  const urlOk = isValidServerUrl(draft.url);

  const runTest = async () => {
    const seq = ++testSeq.current;
    setTest({ busy: true, result: null });
    const result = await testJellyfin(draft.url, draft.apiKey);
    if (seq !== testSeq.current) return;
    setTest({ busy: false, result });
    playSfx(result.status === "ok" ? "confirm" : "error");
  };

  // Schritt 4: Prüfungen starten, sobald der Schritt erreicht ist (und bei "Erneut prüfen").
  useEffect(() => {
    if (step !== STEP_CHECK) return;
    let cancelled = false;
    setResults([]);
    setChecking(true);
    void runChecks(
      {
        jellyfinUrl: draft.url,
        apiKey: draft.apiKey,
        gamesDir: draft.gamesDir,
        biosDir: draft.biosDir,
        controller: probeName.current,
        emulatorOverrides: initial?.emulators,
      },
      (r) => setResults((prev) => [...prev.filter((p) => p.id !== r.id), r]),
      () => cancelled,
    ).finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
    // draft wird bewusst nur beim Betreten des Schritts gelesen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, runId]);

  // Ein Speicherfehler steht unter dem Inhalt – bei kleinem Fenster läge er sonst außerhalb des sichtbaren Bereichs.
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!saveError) return;
    playSfx("error");
    errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [saveError]);

  const finish = async () => {
    setSaving(true);
    setSaveError(null);
    const url = normalizeServerUrl(draft.url);
    // Beim erneuten Ausführen bleiben gewählte Emulatoren erhalten; der Jellyfin-Benutzer nur,
    // solange es derselbe Server ist.
    const sameServer = !!initial && url !== "" && url === initial.jellyfin.url;
    const settings: Settings = {
      version: 1,
      jellyfin: {
        url,
        apiKey: draft.apiKey.trim(),
        ...(sameServer && initial?.jellyfin.userId ? { userId: initial.jellyfin.userId } : {}),
        ...(sameServer && initial?.jellyfin.userName ? { userName: initial.jellyfin.userName } : {}),
      },
      ...(initial?.emulators ? { emulators: initial.emulators } : {}),
      ...(draft.biosDir.trim() ? { biosDir: draft.biosDir.trim() } : {}),
      gamesDir: draft.gamesDir.trim(),
      completedAt: new Date().toISOString(),
    };
    try {
      await saveSettings(settings);
      onComplete(settings);
    } catch (err) {
      setSaveError(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      setSaving(false);
    }
  };

  const last = step === STEPS.length - 1;
  const canNext = useMemo(() => {
    if (step === 0) return isValidServerUrl(draft.url);
    if (step === 1) return draft.gamesDir.trim().length > 0;
    if (step === STEP_CHECK) return !checking && !saving;
    return true;
  }, [step, draft, checking, saving]);
  const canSkip = step < STEP_CHECK;
  const canTest = step === 0 && urlOk && !test.busy;
  const canRecheck = last && !checking && !saving;

  const next = () => {
    if (!canNext) {
      playSfx("error");
      return;
    }
    playSfx("confirm");
    if (last) void finish();
    else setStep((s) => s + 1);
  };
  const back = () => {
    if (step > 0) {
      playSfx("back");
      setStep((s) => s - 1);
    } else if (onCancel) {
      playSfx("back");
      onCancel();
    }
  };
  const skip = () => {
    if (!canSkip) return;
    playSfx("move");
    if (step === 0) patch({ url: "", apiKey: "" });
    if (step === 1) patch({ gamesDir: "" });
    if (step === STEP_FILES) patch({ biosDir: "" });
    setStep((s) => s + 1);
  };
  const retest = () => {
    if (canTest) void runTest();
  };
  const recheck = () => {
    if (!canRecheck) return;
    playSfx("confirm");
    setRunId((n) => n + 1);
  };

  /* ---------- Controller-Bedienung ---------- */

  /** Steuerkreuz hoch/runter: Felder und Buttons des Schritts der Reihe nach anwählen. Hinter dem
   * letzten Element (und vor dem ersten) ist nichts fokussiert – dort wirkt ✕ als "Weiter". */
  const moveFocus = (dir: 1 | -1) => {
    const list = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (list.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const i = active ? list.indexOf(active) : -1;
    const target = i === -1 ? (dir > 0 ? list[0] : list[list.length - 1]) : (list[i + dir] ?? null);
    if (target) target.focus();
    else active?.blur();
    playSfx("move");
  };

  /** Links/rechts wechselt nur innerhalb einer Zeile (Eingabefeld ⇄ daneben liegender Button). */
  const moveInRow = (dir: 1 | -1) => {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest(".setup-input-row");
    if (!active || !row) return;
    const list = Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE));
    const target = list[list.indexOf(active) + dir];
    if (target) {
      target.focus();
      playSfx("move");
    }
  };

  /** ✕: ein fokussierter Button im Schritt wird gedrückt, sonst (auch aus Textfeldern) geht es weiter. */
  const activate = () => {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && !active.disabled && bodyRef.current?.contains(active)) {
      playSfx("confirm");
      active.click();
    } else {
      next();
    }
  };

  const onPad = (action: PadAction) => {
    // Im Controller-Schritt ist der erste Tastendruck der Test selbst (useControllerProbe meldet ihn
    // als "funktioniert"). Er darf nicht gleichzeitig weiterschalten – erst danach gelten ✕ ○ △ wieder.
    if (step === STEP_CONTROLLER && !probe.pressed) return;
    if (saving) return;
    switch (action) {
      case "up":
        return moveFocus(-1);
      case "down":
        return moveFocus(1);
      case "left":
        return moveInRow(-1);
      case "right":
        return moveInRow(1);
      case "confirm":
        return activate();
      case "back":
        return back();
      case "triangle":
        return skip();
      case "square":
        if (step === STEP_FILES) return void requirements.refresh();
        return step === 0 ? retest() : recheck();
    }
  };
  useGamepad({ onAction: onPad });

  // Enter/Escape gelten im ganzen Fenster, nicht nur bei fokussiertem Element: In den Schritten ohne Felder
  // (Controller, Prüfung) und nach einem Mausklick liegt der Fokus auf <body> und ein Element-Handler bekäme nichts.
  const keyHandler = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  keyHandler.current = (e) => {
    if (e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      back();
    }
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ein Mausklick auf einen Button soll den Fokus nicht aus dem Textfeld holen – sonst bliebe er
  // danach am Button hängen und ✕ würde ihn erneut drücken statt weiterzuschalten.
  const onMouseDown = (e: MouseEvent) => {
    if (e.target instanceof Element && e.target.closest("button")) e.preventDefault();
  };

  const problems = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;

  return (
    <div className="setup" onMouseDown={onMouseDown}>
      <Background />
      <div className="setup-vignette" aria-hidden="true" />

      <section className="setup-panel" aria-label="Ersteinrichtung">
        <header className="setup-head">
          <div className="setup-title">
            <div className="setup-logo">JellyStation</div>
            <h1 className="setup-sub">{initial ? "Einrichtung" : "Ersteinrichtung"}</h1>
          </div>
          <ol className="setup-steps" aria-label="Fortschritt">
            {STEPS.map((s, i) => {
              const state = i === step ? "is-active" : i < step ? "is-done" : "is-open";
              return (
                <li key={s.title} className={`setup-steps__item ${state}`} data-symbol={s.symbol} aria-current={i === step ? "step" : undefined}>
                  <span className="setup-steps__mark">
                    <PsSymbol symbol={s.symbol} colored={i <= step} size="1.5rem" />
                    {i < step && (
                      <svg className="setup-steps__done" viewBox="0 0 16 16" aria-hidden="true">
                        <circle cx="8" cy="8" r="8" fill="currentColor" />
                        <path d="M4.6 8.3 7 10.6 11.4 5.8" fill="none" stroke="#06102c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="setup-steps__title">{s.title}</span>
                </li>
              );
            })}
          </ol>
        </header>

        <div className="setup-body" key={step} ref={bodyRef}>
          {step === 0 && <JellyfinStep draft={draft} onChange={patch} test={test} onTest={runTest} />}
          {step === 1 && <GamesStep draft={draft} onChange={patch} />}
          {step === STEP_FILES && <FilesStep draft={draft} onChange={patch} emulators={emulators} requirements={requirements} />}
          {step === STEP_CONTROLLER && <ControllerStep name={probe.name} pressed={probe.pressed} />}
          {step === STEP_CHECK && <CheckStep results={results} />}
          {saveError && (
            <p ref={errorRef} className="setup-result is-fail setup-save-error" role="alert">
              {saveError}
            </p>
          )}
        </div>

        <footer className="setup-actions">
          {(step > 0 || onCancel) && (
            <Hint symbol="circle" label={step === 0 ? "Abbrechen" : "Zurück"} onClick={back} disabled={saving} />
          )}
          <span className="setup-actions__spacer">
            {last && !checking && results.length > 0 && (problems > 0 || warnings > 0) && (
              <span className="setup-summary">
                {problems > 0 && `${problems} Fehler`}
                {problems > 0 && warnings > 0 && " · "}
                {warnings > 0 && `${warnings} Hinweis${warnings > 1 ? "e" : ""}`}
              </span>
            )}
          </span>
          {canSkip && <Hint symbol="triangle" label="Überspringen" onClick={skip} />}
          {step === 0 && <Hint symbol="square" label="Verbindung testen" onClick={retest} disabled={!canTest} />}
          {step === STEP_FILES && <Hint symbol="square" label="Neu prüfen" onClick={() => void requirements.refresh()} />}
          {last && <Hint symbol="square" label="Erneut prüfen" onClick={recheck} disabled={!canRecheck} />}
          <Hint
            symbol="cross"
            label={last ? (saving ? "Speichere …" : "Einrichtung abschließen") : "Weiter"}
            onClick={next}
            disabled={!canNext}
            primary
          />
        </footer>
      </section>
    </div>
  );
}

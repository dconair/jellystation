import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useControllerProbe } from "../input/useControllerProbe";
import { isValidServerUrl, normalizeServerUrl, testJellyfin } from "../jellyfin/testConnection";
import type { ConnectionResult } from "../jellyfin/testConnection";
import { saveSettings } from "../settings/settings";
import type { Settings } from "../settings/settings";
import { Background } from "../xmb/Background";
import { runChecks } from "./checks";
import type { CheckResult } from "./checks";
import { CheckStep, ControllerStep, GamesStep, JellyfinStep } from "./steps";
import type { Draft } from "./steps";
import "./setup.css";

interface SetupWizardProps {
  /** Vorhandene Einstellungen (beim erneuten Ausführen). */
  initial?: Settings | null;
  onComplete: (settings: Settings) => void;
  /** Nur gesetzt, wenn bereits eine Konfiguration existiert. */
  onCancel?: () => void;
}

const STEPS = [
  { symbol: "△", title: "Jellyfin" },
  { symbol: "○", title: "Spiele" },
  { symbol: "✕", title: "Controller" },
  { symbol: "□", title: "Prüfung" },
] as const;

export function SetupWizard({ initial, onComplete, onCancel }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({
    url: initial?.jellyfin.url ?? "",
    apiKey: initial?.jellyfin.apiKey ?? "",
    gamesDir: initial?.gamesDir ?? "",
  });
  const [test, setTest] = useState<{ busy: boolean; result: ConnectionResult | null }>({
    busy: false,
    result: null,
  });
  const [results, setResults] = useState<CheckResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [runId, setRunId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const probe = useControllerProbe(true);
  const probeName = useRef(probe.name);
  probeName.current = probe.name;

  const patch = useCallback((p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    if ("url" in p || "apiKey" in p) setTest((t) => ({ ...t, result: null }));
  }, []);

  const runTest = async () => {
    setTest({ busy: true, result: null });
    const result = await testJellyfin(draft.url, draft.apiKey);
    setTest({ busy: false, result });
  };

  // Schritt 4: Prüfungen starten, sobald der Schritt erreicht ist (und bei "Erneut prüfen").
  useEffect(() => {
    if (step !== 3) return;
    let cancelled = false;
    setResults([]);
    setChecking(true);
    void runChecks(
      {
        jellyfinUrl: draft.url,
        apiKey: draft.apiKey,
        gamesDir: draft.gamesDir,
        controller: probeName.current,
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

  const finish = async () => {
    setSaving(true);
    setSaveError(null);
    const settings: Settings = {
      version: 1,
      jellyfin: { url: normalizeServerUrl(draft.url), apiKey: draft.apiKey.trim() },
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
    if (step === 3) return !checking && !saving;
    return true;
  }, [step, draft, checking, saving]);
  const canSkip = step < 3;

  const next = () => {
    if (!canNext) return;
    if (last) void finish();
    else setStep((s) => s + 1);
  };
  const back = () => {
    if (step > 0) setStep((s) => s - 1);
    else onCancel?.();
  };
  const skip = () => {
    if (step === 0) patch({ url: "", apiKey: "" });
    if (step === 1) patch({ gamesDir: "" });
    setStep((s) => s + 1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      back();
    }
  };

  const problems = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;

  return (
    <div className="setup" onKeyDown={onKeyDown}>
      <Background />
      <div className="xmb-vignette" aria-hidden="true" />

      <section className="setup-panel" aria-label="Ersteinrichtung">
        <header className="setup-head">
          <div>
            <div className="setup-logo">JellyStation</div>
            <div className="setup-sub">{initial ? "Einrichtung" : "Ersteinrichtung"}</div>
          </div>
          <ol className="setup-steps" aria-label="Fortschritt">
            {STEPS.map((s, i) => (
              <li key={s.title} className={i === step ? "is-active" : i < step ? "is-done" : ""}>
                <span className="setup-steps__symbol">{s.symbol}</span>
                <span className="setup-steps__title">{s.title}</span>
              </li>
            ))}
          </ol>
        </header>

        <div className="setup-body" key={step}>
          {step === 0 && <JellyfinStep draft={draft} onChange={patch} test={test} onTest={runTest} />}
          {step === 1 && <GamesStep draft={draft} onChange={patch} />}
          {step === 2 && <ControllerStep name={probe.name} pressed={probe.pressed} />}
          {step === 3 && <CheckStep results={results} />}
        </div>

        {saveError && <p className="setup-result is-fail">{saveError}</p>}

        <footer className="setup-actions">
          <button type="button" className="ps-btn ps-btn--ghost" onClick={back} disabled={step === 0 && !onCancel}>
            <span className="ps-glyph">○</span> {step === 0 ? "Abbrechen" : "Zurück"}
          </button>
          <span className="setup-actions__spacer">
            {last && !checking && results.length > 0 && (problems > 0 || warnings > 0) && (
              <span className="setup-summary">
                {problems > 0 && `${problems} Fehler`}
                {problems > 0 && warnings > 0 && " · "}
                {warnings > 0 && `${warnings} Hinweis${warnings > 1 ? "e" : ""}`}
              </span>
            )}
          </span>
          {last && (
            <button type="button" className="ps-btn ps-btn--ghost" disabled={checking} onClick={() => setRunId((n) => n + 1)}>
              Erneut prüfen
            </button>
          )}
          {canSkip && (
            <button type="button" className="ps-btn ps-btn--ghost" onClick={skip}>
              Überspringen
            </button>
          )}
          <button type="button" className="ps-btn ps-btn--primary" disabled={!canNext} onClick={next}>
            <span className="ps-glyph">✕</span> {last ? (saving ? "Speichere …" : "Einrichtung abschließen") : "Weiter"}
          </button>
        </footer>
      </section>
    </div>
  );
}

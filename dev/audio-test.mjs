// Offline-Test der Hintergrundmusik: rendert jede Stimmung und prüft Pegel/Spektrum; schreibt WAV-Dateien.
//   npx vite --port 5304 --strictPort --host 127.0.0.1 &   dann:
//   node dev/audio-test.mjs --app http://127.0.0.1:5304 --out <Ordner> [--seconds 40]
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APP = arg("app", "http://127.0.0.1:1420"), OUT = path.resolve(arg("out", "./audio-out")), SECONDS = Number(arg("seconds", "40"));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await import(arg("playwright", "playwright"));
const b = await chromium.launch({ executablePath: arg("chromium", undefined), args: ["--no-sandbox"] });
const page = await b.newPage();
await page.goto(APP);
let failed = 0;
const check = (n, ok, x = "") => { console.log(`${ok ? "OK  " : "FEHLT"} ${n}${x ? " – " + x : ""}`); if (!ok) failed++; };
for (const mood of ["sanft", "tiefsee", "nacht", "morgen"]) {
  const r = await page.evaluate(async ([mood, seconds]) => {
    const { renderMood } = await import("/src/audio/ambient.ts");
    const buf = await renderMood(mood, seconds, 0.4);
    const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate;
    let peak = 0, nan = 0;
    for (let i = 0; i < L.length; i++) { const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (v > peak) peak = v; if (!Number.isFinite(L[i])) nan++; }
    const win = sr * 2, rms = [];
    for (let s = 0; s + win <= L.length; s += win) { let a = 0; for (let i = s; i < s + win; i++) a += L[i] * L[i]; rms.push(Math.sqrt(a / win)); }
    // Spektrum (naives DFT über 2048 Samples in der Mitte): Energie < 400 Hz und > 2 kHz
    const N = 2048, start = Math.floor(L.length / 2);
    let low = 0, high = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sr) / N; let re = 0, im = 0;
      for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N); const x = L[start + n] * w; re += x * Math.cos((2 * Math.PI * k * n) / N); im -= x * Math.sin((2 * Math.PI * k * n) / N); }
      const e = re * re + im * im; if (f < 400) low += e; else if (f > 2000) high += e;
    }
    // WAV (16 Bit, Mono-Mix) als Base64
    const pcm = new Int16Array(L.length); for (let i = 0; i < L.length; i++) pcm[i] = Math.max(-1, Math.min(1, (L[i] + R[i]) / 2)) * 32767;
    const bytes = new Uint8Array(44 + pcm.length * 2), dv = new DataView(bytes.buffer);
    const w4 = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w4(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w4(8, "WAVEfmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w4(36, "data"); dv.setUint32(40, pcm.length * 2, true);
    bytes.set(new Uint8Array(pcm.buffer), 44);
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { peak, nan, rms, low, high, wav: btoa(bin) };
  }, [mood, SECONDS]);
  fs.writeFileSync(path.join(OUT, `${mood}.wav`), Buffer.from(r.wav, "base64"));
  const rmsDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));
  const lateRms = r.rms.slice(2), mean = lateRms.reduce((a, v) => a + v, 0) / lateRms.length;
  const spread = Math.max(...lateRms) / Math.max(Math.min(...lateRms), 1e-9);
  console.log(`-- ${mood}: Spitze ${rmsDb(r.peak).toFixed(1)} dBFS, RMS ${rmsDb(mean).toFixed(1)} dBFS, Schwankung ×${spread.toFixed(2)}`);
  check(`${mood}: keine NaN`, r.nan === 0);
  check(`${mood}: nicht übersteuert (Spitze < -1 dBFS)`, r.peak < 0.9, `${rmsDb(r.peak).toFixed(1)} dBFS`);
  check(`${mood}: hörbar, aber leise (RMS -45…-20 dBFS)`, rmsDb(mean) > -45 && rmsDb(mean) < -20, `${rmsDb(mean).toFixed(1)} dBFS`);
  check(`${mood}: Tiefen vorhanden (Energie < 400 Hz dominiert)`, r.low > r.high * 2, `tief/hoch = ${(r.low / Math.max(r.high, 1e-12)).toFixed(1)}`);
  check(`${mood}: Lautstärke atmet langsam (Schwankung 1,05…3×)`, spread > 1.05 && spread < 3, `×${spread.toFixed(2)}`);
}
await b.close();
console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : "Alles in Ordnung");
process.exit(failed ? 1 : 0);

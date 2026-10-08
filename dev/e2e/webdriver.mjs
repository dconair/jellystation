// Minimaler W3C-WebDriver-Client (nur fetch) für WebKitWebDriver und tauri-driver – nur für Tests unter Linux.
import { spawn } from "node:child_process";
export class WebDriver {
  constructor(base) { this.base = base; this.sid = null; }
  async req(method, path, body) {
    const res = await fetch(this.base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.value?.error) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(j.value)?.slice(0, 400)}`);
    return j.value;
  }
  async newSession(caps) { const v = await this.req("POST", "/session", { capabilities: { alwaysMatch: caps } }); this.sid = v.sessionId; return v; }
  go(url) { return this.req("POST", `/session/${this.sid}/url`, { url }); }
  exec(script, args = []) { return this.req("POST", `/session/${this.sid}/execute/sync`, { script, args }); }
  execAsync(script, args = []) { return this.req("POST", `/session/${this.sid}/execute/async`, { script, args }); }
  async screenshot(file) { const b64 = await this.req("GET", `/session/${this.sid}/screenshot`); const fs = await import("node:fs"); fs.writeFileSync(file, Buffer.from(b64, "base64")); }
  async quit() { try { await this.req("DELETE", `/session/${this.sid}`); } catch {} }
  setTimeouts(t) { return this.req("POST", `/session/${this.sid}/timeouts`, t); }
}
export function startDriver(bin, port, args = []) {
  const child = spawn(bin, [`--port=${port}`, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.WD_LOG && process.stdout.write("[driver] " + d));
  child.stderr.on("data", (d) => process.env.WD_LOG && process.stdout.write("[driver!] " + d));
  return child;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

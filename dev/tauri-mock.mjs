// Test-Attrappe für die Tauri-Schnittstelle (nur für Playwright-Tests, gehört nicht zur App).
//
// Die App erkennt Tauri an window.__TAURI_INTERNALS__ (src/platform.ts). Diese Attrappe setzt es im Browser
// und leitet jeden Aufruf von invoke() an Node weiter. Dort beantworten Standard-Handler die Plugins
//   store (im Speicher), fs/path (virtuelles Dateisystem), dialog, http (echte Netzwerkaufrufe aus Node)
// und event (listen/unlisten/emit) sowie shell (spawn mit Channel-Ereignissen, kill, open; siehe mock.shell). Eigene Rust-Befehle (media_proxy_start, emulator_find, game_launch, …)
// registrierst du mit mock.on("befehl", async (args) => …); nicht registrierte Befehle schlagen laut fehl.
//
// Beispiel:
//   import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
//   import { installTauriMock } from "/home/user/jellystation/dev/tauri-mock.mjs";
//   const page = await (await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] })).newPage();
//   const mock = await installTauriMock(page, {
//     store: { "settings.json": { settings: { version: 1, jellyfin: { url: "", apiKey: "" }, gamesDir: "", completedAt: "2026-01-01T00:00:00Z" } } },
//     fs: { "/Users/test/JellyStation/Games/PS3": ["Spiel.iso"] },   // Ordner → Dateinamen
//     home: "/Users/test",
//   });
//   mock.on("game_launch", async ({ id }) => ({ id, pid: 1234, executable: "/x", commandLine: "x" }));
//   await page.goto("http://127.0.0.1:5173/");
//   await mock.emit("game-exit", { id: "…", code: 0, signal: null, durationMs: 1000, stderrTail: [], stdoutTail: [] });

/**
 * @param {import("playwright").Page} page
 * @param {{
 *   store?: Record<string, Record<string, unknown>>,
 *   fs?: Record<string, string[] | Uint8Array | string>,
 *   home?: string,
 *   dialog?: unknown,
 *   handlers?: Record<string, (args: any) => unknown | Promise<unknown>>,
 *   log?: boolean,
 * }} [options]
 */
export async function installTauriMock(page, options = {}) {
  const home = options.home ?? "/Users/test";
  const handlers = new Map(Object.entries(options.handlers ?? {}));
  /** Alle Aufrufe in Reihenfolge: { cmd, args }. */
  const calls = [];
  /** Store-Inhalte je Datei, z. B. stores["settings.json"].get("settings"). */
  const stores = new Map(Object.entries(options.store ?? {}).map(([file, obj]) => [file, new Map(Object.entries(obj))]));
  const storeRids = new Map(); // rid → Map
  /** Virtuelles Dateisystem: Pfad → string[] (Ordner mit Namen) | Uint8Array/string (Datei). */
  const vfs = new Map(Object.entries(options.fs ?? {}));
  const httpRequests = new Map();
  const httpResponses = new Map();
  let nextRid = 1000;
  let dialogResult = options.dialog ?? null;

  const norm = (p) => String(p).replace(/\/+$/, "") || "/";
  const isDir = (p) => {
    const path = norm(p);
    if (vfs.has(path) && Array.isArray(vfs.get(path))) return true;
    // implizite Ordner: Vorfahren von Einträgen
    for (const key of vfs.keys()) if (key.startsWith(path + "/")) return true;
    return false;
  };
  const fileOf = (p) => {
    const path = norm(p);
    const direct = vfs.get(path);
    if (direct !== undefined && !Array.isArray(direct)) return direct;
    const slash = path.lastIndexOf("/");
    const dir = vfs.get(path.slice(0, slash) || "/");
    if (Array.isArray(dir) && dir.includes(path.slice(slash + 1))) return "";
    return undefined;
  };
  const dirEntries = (p) => {
    const path = norm(p);
    const names = new Map();
    const direct = vfs.get(path);
    if (Array.isArray(direct)) for (const n of direct) names.set(n, /\.(app)$/i.test(n) ? "dir" : "file");
    for (const key of vfs.keys()) {
      if (key.startsWith(path + "/")) {
        const rest = key.slice(path.length + 1);
        const first = rest.split("/")[0];
        names.set(first, rest.includes("/") || Array.isArray(vfs.get(key)) ? "dir" : "file");
      }
    }
    return [...names].map(([name, kind]) => ({ name, isDirectory: kind === "dir", isFile: kind === "file", isSymlink: false }));
  };

  // ---- plugin-shell: Prozesse, die die App per Command.create(...).spawn() startet ----
  let nextPid = 4100;
  let spawnHandler = null;
  /** pid → Prozess-Steuerung (siehe mock.shell). */
  const procs = new Map();
  /** Pfade/Adressen, die die App mit open() (plugin-shell) öffnen wollte. */
  const opened = [];
  const shellState = { reject: null };
  const channelIdOf = (value) => {
    // Channel wird je nach Übertragungsweg als "__CHANNEL__:7" oder als Objekt { id: 7 } geliefert.
    if (typeof value === "string") return Number(value.replace("__CHANNEL__:", ""));
    return Number(value?.id);
  };

  const defaults = {
    "plugin:store|load": ({ path }) => {
      if (!stores.has(path)) stores.set(path, new Map());
      const rid = nextRid++;
      storeRids.set(rid, stores.get(path));
      return rid;
    },
    "plugin:store|get_store": ({ path }) => {
      if (!stores.has(path)) return null;
      const rid = nextRid++;
      storeRids.set(rid, stores.get(path));
      return rid;
    },
    "plugin:store|get": ({ rid, key }) => {
      const s = storeRids.get(rid);
      return s && s.has(key) ? [s.get(key), true] : [null, false];
    },
    "plugin:store|set": ({ rid, key, value }) => void storeRids.get(rid)?.set(key, value),
    "plugin:store|has": ({ rid, key }) => !!storeRids.get(rid)?.has(key),
    "plugin:store|delete": ({ rid, key }) => !!storeRids.get(rid)?.delete(key),
    "plugin:store|save": () => undefined,
    "plugin:path|resolve_directory": () => home,
    "plugin:fs|exists": ({ path }) => vfs.has(norm(path)) || isDir(path) || fileOf(path) !== undefined,
    "plugin:fs|read_dir": ({ path }) => {
      if (!isDir(path)) throw new Error(`Ordner nicht gefunden: ${path}`);
      return dirEntries(path);
    },
    "plugin:fs|read_file": ({ path }) => {
      const f = fileOf(path);
      if (f === undefined) throw new Error(`Datei nicht gefunden: ${path}`);
      return Array.from(typeof f === "string" ? Buffer.from(f) : f);
    },
    "plugin:dialog|open": () => dialogResult,
    // ---- plugin-shell ----
    "plugin:shell|spawn": ({ program, args, options, onEvent }) => {
      // mock.shell.reject = "Text": das Plugin lehnt ab (z. B. Programm nicht im Shell-Scope erlaubt)
      if (shellState.reject) throw new Error(shellState.reject);
      const channel = channelIdOf(onEvent);
      const pid = nextPid++;
      const send = (message) => page.evaluate(([id, m]) => window.__mockChannelSend(id, m), [channel, message]).catch((e) => { if (!page.isClosed()) throw e; });
      const proc = {
        pid,
        program,
        args,
        options,
        killed: false,
        /** Zeile auf stdout / stderr ausgeben (wie das Plugin: eine Zeile je Ereignis). */
        stdout: (line) => send({ event: "Stdout", payload: line }),
        stderr: (line) => send({ event: "Stderr", payload: line }),
        /** Prozess endet (Terminated) und der Kanal wird geschlossen. */
        close: async (code = 0, signal = null) => {
          await send({ event: "Terminated", payload: { code, signal } });
          await page.evaluate((id) => window.__mockChannelEnd(id), channel).catch((e) => { if (!page.isClosed()) throw e; });
        },
        /** Fehler-Ereignis des Plugins (Prozess konnte nicht laufen). */
        error: (message) => send({ event: "Error", payload: message }),
        /** Wird bei kill() aufgerufen; Standard: Ende durch Signal 9. */
        onKill: null,
      };
      procs.set(pid, proc);
      if (spawnHandler) setTimeout(() => Promise.resolve(spawnHandler(proc)).catch((e) => console.error("[tauri-mock] spawn-Handler:", e)), 30);
      return pid;
    },
    "plugin:shell|kill": ({ pid }) => {
      const proc = procs.get(pid);
      if (!proc) throw new Error(`Prozess nicht gefunden: ${pid}`);
      proc.killed = true;
      return Promise.resolve(proc.onKill ? proc.onKill() : proc.close(null, 9)).then(() => undefined);
    },
    "plugin:shell|open": ({ path }) => void opened.push(path),
    // ---- plugin-http: echte Anfragen aus Node ----
    "plugin:http|fetch": ({ clientConfig }) => {
      const rid = nextRid++;
      httpRequests.set(rid, clientConfig);
      return rid;
    },
    "plugin:http|fetch_send": async ({ rid }) => {
      const cfg = httpRequests.get(rid);
      if (!cfg) throw new Error("Unbekannte Anfrage");
      const res = await fetch(cfg.url, {
        method: cfg.method,
        headers: Object.fromEntries(cfg.headers),
        body: cfg.data ? Buffer.from(cfg.data) : undefined,
        redirect: "manual",
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const respRid = nextRid++;
      httpResponses.set(respRid, { bytes, offset: 0 });
      return { status: res.status, statusText: res.statusText, url: res.url || cfg.url, headers: [...res.headers.entries()], rid: respRid };
    },
    "plugin:http|fetch_read_body": ({ rid }) => {
      const r = httpResponses.get(rid);
      if (!r) return [1];
      const chunk = r.bytes.subarray(r.offset, r.offset + 65536);
      r.offset += chunk.length;
      if (chunk.length === 0) return [1]; // letztes Byte 1 = Ende
      return [...chunk, 0];
    },
    "plugin:http|fetch_cancel": () => undefined,
    "plugin:http|fetch_cancel_body": () => undefined,
  };

  await page.exposeFunction("__tauriMockInvoke", async (cmd, args) => {
    calls.push({ cmd, args });
    if (options.log) console.log("[tauri-mock]", cmd, JSON.stringify(args)?.slice(0, 200));
    const fn = handlers.get(cmd) ?? defaults[cmd];
    if (!fn) throw new Error(`Befehl nicht gemockt: ${cmd}`);
    const out = await fn(args ?? {});
    return out === undefined ? null : out;
  });

  await page.addInitScript(() => {
    const callbacks = new Map();
    let nextCallback = 1;
    const listeners = new Map(); // Ereignis → Map(eventId → Callback-ID)
    let nextEventId = 1;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback(cb, once) {
        const id = nextCallback++;
        callbacks.set(id, (...a) => {
          if (once) callbacks.delete(id);
          return cb && cb(...a);
        });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      convertFileSrc: (p) => p,
      async invoke(cmd, args) {
        // Channel-Objekte (z. B. onEvent beim Shell-Plugin) wie das echte IPC zu "__CHANNEL__:<id>" machen.
        if (args && typeof args === "object" && !Array.isArray(args)) {
          for (const [k, v] of Object.entries(args)) {
            if (v && typeof v === "object" && typeof v.toJSON === "function") args = { ...args, [k]: v.toJSON() };
          }
        }
        if (cmd === "plugin:event|listen") {
          const id = nextEventId++;
          if (!listeners.has(args.event)) listeners.set(args.event, new Map());
          listeners.get(args.event).set(id, args.handler);
          return id;
        }
        if (cmd === "plugin:event|unlisten") {
          listeners.get(args.event)?.delete(args.eventId);
          return null;
        }
        if (cmd === "plugin:event|emit") {
          window.__mockEmit(args.event, args.payload);
          return null;
        }
        return window.__tauriMockInvoke(cmd, args);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, id) {
        listeners.get(event)?.delete(id);
      },
    };
    window.__mockEmit = (event, payload) => {
      for (const [id, cb] of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id, payload });
    };
    // Nachrichten eines Channels in der Reihenfolge zustellen, die core.js erwartet ({ index, message } bzw. { index, end }).
    const channelIndex = new Map();
    window.__mockChannelSend = (id, message) => {
      const index = channelIndex.get(id) ?? 0;
      channelIndex.set(id, index + 1);
      callbacks.get(id)?.({ index, message });
    };
    window.__mockChannelEnd = (id) => {
      callbacks.get(id)?.({ index: channelIndex.get(id) ?? 0, end: true });
      channelIndex.delete(id);
    };
  });

  return {
    calls,
    stores,
    vfs,
    /** Eigenen Handler für einen Befehl setzen (ersetzt einen Standard-Handler). */
    on(cmd, fn) {
      handlers.set(cmd, fn);
    },
    /** Ergebnis des nächsten Ordnerdialogs festlegen (Pfad, Pfadliste oder null = abgebrochen). */
    setDialogResult(value) {
      dialogResult = value;
    },
    /** Ereignis an die App schicken (wie app.emit in Rust). */
    async emit(event, payload) {
      await page.evaluate(([e, p]) => window.__mockEmit(e, p), [event, payload]);
    },
    /** Aufrufe eines Befehls. */
    callsOf: (cmd) => calls.filter((c) => c.cmd === cmd),
    /**
     * plugin-shell: gestartete Prozesse und open()-Aufrufe.
     *   mock.shell.onSpawn(async (proc) => { await proc.stdout("zeile"); await proc.close(0); })
     * proc: { pid, program, args, options, stdout(line), stderr(line), close(code, signal), error(msg), killed, onKill }
     * Ohne Handler läuft ein gestarteter Prozess einfach weiter (Ende nur über proc.close()).
     */
    shell: {
      procs,
      opened,
      onSpawn(fn) {
        spawnHandler = fn;
      },
      /** Nächste spawn()-Aufrufe lehnt das Plugin mit diesem Text ab (null = wieder erlauben). */
      set reject(message) {
        shellState.reject = message;
      },
      get reject() {
        return shellState.reject;
      },
    },
  };
}

/**
 * Simuliert die Rust-Befehle für Emulatoren (emulator_find, emulator_inspect, game_launch, game_kill, game_running,
 * launch_log_tail) samt `game-exit` und – über mock.shell – `brew install --cask` mit Homebrew-ähnlicher Ausgabe.
 * Gebraucht von den Tests des Emulator-Dialogs und des Spielstarts; die echten Befehle stehen in src-tauri/src/emulators.rs.
 *
 *   const fake = installFakeEmulatorBackend(mock, {
 *     brew: "arm",                                       // "arm" | "intel" | false
 *     apps: { "/Applications/RPCS3.app": { version: "0.0.34" } },
 *   });
 *   fake.addApp("/Users/test/Downloads/PCSX2.app", { version: "2.0.0" });
 *   fake.onLaunch((req, ctl) => setTimeout(() => ctl.exit({ code: 1, stderrTail: ["Fehler"] }), 300));
 *
 * Felder: fake.launches (Aufrufe von game_launch), fake.running (Set der laufenden IDs), fake.log (launch.log),
 * fake.brewCalls, fake.brewScript = { lines, stderr, code, error, delayMs, installs: { Cask: { path, ...Infos } } },
 * fake.findError / fake.inspectError = "Text" (der jeweilige Befehl schlägt fehl).
 */
export function installFakeEmulatorBackend(mock, options = {}) {
  const home = options.home ?? "/Users/test";
  const apps = new Map(); // Pfad → { kind, executable, name, bundleId, version, error }
  const fake = {
    launches: [],
    running: new Set(),
    log: [],
    brewCalls: [],
    findError: null,
    inspectError: null,
    brewScript: {
      lines: ["==> Downloading https://example.invalid/app.dmg", "######################################################################## 100.0%", "==> Installing Cask app", "==> Moving App 'App.app' to '/Applications/App.app'", "🍺  app was successfully installed!"],
      stderr: [],
      code: 0,
      delayMs: 120,
      /** Cask → { path, ...Infos }: wird nach erfolgreicher Installation zu einer gefundenen App. */
      installs: {},
    },
    addApp(path, info = {}) {
      const isBundle = /\.app\/?$/i.test(path);
      apps.set(path.replace(/\/+$/, ""), {
        kind: isBundle ? "bundle" : "file",
        executable: true,
        name: path.split("/").filter(Boolean).pop()?.replace(/\.app$/i, "") ?? path,
        bundleId: null,
        version: null,
        error: null,
        ...info,
      });
      return fake;
    },
    removeApp(path) {
      apps.delete(path.replace(/\/+$/, ""));
      return fake;
    },
    /** Hook beim Start: (req, ctl) => void | { error: "Text" }. ctl.exit(payload) beendet den Prozess. */
    onLaunch(fn) {
      launchHandler = fn;
    },
    /** `game-exit` an die App schicken und den Prozess als beendet markieren. */
    async exit(id, payload = {}) {
      fake.running.delete(id);
      fake.log.push(`[ende] ${id} code=${payload.code ?? 0} signal=${payload.signal ?? "-"}`);
      await mock.emit("game-exit", { id, code: 0, signal: null, durationMs: 1000, stderrTail: [], stdoutTail: [], hint: null, ...payload });
    },
  };
  let launchHandler = null;
  let nextPid = 7200;

  if (options.brew) {
    const path = options.brew === "intel" ? "/usr/local/bin/brew" : "/opt/homebrew/bin/brew";
    fake.addApp(path, { kind: "file", name: "brew" });
  }
  for (const [path, info] of Object.entries(options.apps ?? {})) fake.addApp(path, info);

  const sourceOf = (p) => {
    const under = (dir) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : null);
    let rest;
    if ((rest = under("/Applications")) !== null) return rest.includes("/") ? "subfolder" : "applications";
    if ((rest = under(home + "/Applications")) !== null) return rest.includes("/") ? "subfolder" : "user-applications";
    if (under(home + "/Downloads") !== null) return "downloads";
    if (under(home + "/Desktop") !== null) return "desktop";
    return "spotlight";
  };
  const RANK = ["applications", "user-applications", "subfolder", "downloads", "desktop", "spotlight"];

  mock.on("emulator_find", async ({ specs }) => {
    if (fake.findError) throw fake.findError;
    return specs.map((spec) => {
      const re = new RegExp(spec.appPattern, "i");
      const matches = [...apps.entries()]
        .filter(([path, a]) => a.kind === "bundle" && re.test(path.split("/").pop()))
        .map(([path]) => ({ path, source: sourceOf(path) }))
        .sort((a, b) => RANK.indexOf(a.source) - RANK.indexOf(b.source));
      return { id: spec.id, matches };
    });
  });

  // Formen wie in src-tauri/src/emulators.rs: `executable` ist der Pfad der Programmdatei (oder null), `error` deutscher Text.
  const exeOf = (clean, a) => (a.kind === "bundle" ? `${clean}/Contents/MacOS/${a.name}` : clean);
  mock.on("emulator_inspect", async ({ path }) => {
    if (fake.inspectError) throw fake.inspectError;
    const clean = String(path).replace(/\/+$/, "");
    const a = apps.get(clean);
    if (!a) return { path, exists: false, kind: "other", executable: null, name: null, bundleId: null, version: null, error: `Pfad nicht gefunden: ${clean}` };
    return {
      path,
      exists: true,
      kind: a.kind,
      executable: a.executable ? exeOf(clean, a) : null,
      name: a.name,
      bundleId: a.bundleId,
      version: a.version,
      error: a.executable ? null : (a.error ?? `Die Datei ist nicht ausführbar (Ausführungsrecht fehlt): ${clean}`),
    };
  });

  mock.on("game_launch", async (req) => {
    fake.launches.push(req);
    const label = req.label || req.id;
    if (fake.running.has(req.id)) throw `„${label}“ läuft bereits`;
    const clean = String(req.program).replace(/\/+$/, "");
    const app = apps.get(clean);
    if (!app) throw `Programm nicht gefunden: ${req.program}`;
    if (!app.executable) throw `Keine ausführbare Datei (Ausführungsrecht fehlt): ${req.program}`;
    const exe = exeOf(clean, app);
    const quote = (a) => (/[\s"]/.test(a) ? `'${a}'` : a);
    const commandLine = [exe, ...req.args.map(quote)].join(" ");
    fake.running.add(req.id);
    fake.log.push(`[start] ${req.id} ${commandLine}`);
    const ctl = { exit: (payload) => fake.exit(req.id, payload) };
    if (launchHandler) {
      const r = await launchHandler(req, ctl);
      if (r && r.error) {
        fake.running.delete(req.id);
        throw r.error;
      }
    }
    return { id: req.id, pid: nextPid++, executable: exe, commandLine };
  });

  mock.on("game_kill", async ({ id }) => {
    if (!fake.running.has(id)) return false;
    await fake.exit(id, { code: null, signal: "SIGKILL" });
    return true;
  });
  mock.on("game_running", async () => [...fake.running]);
  mock.on("launch_log_tail", async ({ lines }) => fake.log.slice(-lines));

  // Homebrew über den Shell-Scope: brew-arm / brew-intel
  mock.shell.onSpawn(async (proc) => {
    if (!/^brew-(arm|intel)$/.test(proc.program)) return proc.error(`Programm nicht erlaubt: ${proc.program}`);
    fake.brewCalls.push({ program: proc.program, args: proc.args, options: proc.options });
    const script = fake.brewScript;
    const cask = proc.args[2];
    for (const line of script.lines) {
      await new Promise((r) => setTimeout(r, script.delayMs));
      await proc.stdout(line);
    }
    for (const line of script.stderr) await proc.stderr(line);
    // script.error = "Text": das Plugin meldet einen Fehler statt eines normalen Endes (Error-Ereignis)
    if (script.error) return proc.error(script.error);
    if (script.code === 0 && script.installs[cask]) {
      const { path, ...info } = script.installs[cask];
      fake.addApp(path, info);
    }
    await proc.close(script.code, null);
  });

  return fake;
}

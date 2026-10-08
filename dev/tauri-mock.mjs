// Test-Attrappe für die Tauri-Schnittstelle (nur für Playwright-Tests, gehört nicht zur App).
//
// Die App erkennt Tauri an window.__TAURI_INTERNALS__ (src/platform.ts). Diese Attrappe setzt es im Browser
// und leitet jeden Aufruf von invoke() an Node weiter. Dort beantworten Standard-Handler die Plugins
//   store (im Speicher), fs/path (virtuelles Dateisystem), dialog, http (echte Netzwerkaufrufe aus Node)
// und event (listen/unlisten/emit). Eigene Rust-Befehle (media_proxy_start, emulator_find, game_launch, …)
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
  };
}

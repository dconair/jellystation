#!/usr/bin/env node
// Mock-Jellyfin: ein kleiner Jellyfin-Server für Tests (nur Node, keine Abhängigkeiten, gehört nicht zur App).
//
//   Als Bibliothek:  import { startMockJellyfin } from "./server.mjs";
//                    const mock = await startMockJellyfin({ port: 18110, apiKey: "abc123", mediaDir });
//                    …  await mock.close();
//   Als Programm:    node server.mjs --port 18110 [--key abc123] [--media ./media] [--scenario transcode,legacy]
//
// Die Medien (WebM/MKV/HLS/Untertitel) erzeugt make-media.sh. Ohne sie antworten nur die Medien-Endpunkte mit 404.
// Steuerung und Beobachtung: siehe README.md  (/__mock/log, /__mock/scenario, /__mock/reset, /__mock/config …).
//
// Ziel ist, dass sich der Client gegenüber diesem Server genauso verhalten muss wie gegenüber einem echten:
// Anmeldung per Header/Query, PlaybackInfo mit Aushandlung nach dem gesendeten Geräteprofil, Range-Anfragen,
// HLS mit relativen/root-relativen/absoluten Adressen, Benutzerdaten (alte und neue Pfade), Sitzungsmeldungen ohne
// Benutzer (wie bei API-Keys), Proxy-Nachbildung unter /p/<Token>/….

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_KEY = "abc123";
/** Token eines normalen Benutzers (Alice): darf die Benutzerliste nicht lesen, wohl aber `/Users/Me`. */
export const USER_TOKEN = "alice-token";
const TICKS = 10_000_000;
const CLIP_SEC = 30;
const RUN_TICKS = CLIP_SEC * TICKS;

/* ============================================================== Testdaten */

/** 32 Hex-Zeichen wie echte Jellyfin-IDs (Guid ohne Bindestriche). */
const gid = (code, n) => `${code}${n.toString(16).padStart(6, "0")}`.padEnd(32, "0");

const LONG =
  "Im Jahr 2049 stößt ein junger Blade Runner auf ein lange verborgenes Geheimnis, das die Reste der Gesellschaft ins Chaos stürzen könnte. Seine Entdeckung führt ihn zu Rick Deckard, einem seit dreißig Jahren verschwundenen ehemaligen Blade Runner. Gemeinsam begeben sie sich auf eine gefährliche Suche quer durch ein zerstörtes Los Angeles, in dem nichts so ist, wie es scheint, und jede Spur ins Verderben führen kann. Am Ende steht eine Entscheidung, die alles verändert.";

// [Name, Jahr, Genres, Inhalt, hatCover]
const MOVIE_ROWS = [
  ["Testfilm", 2024, ["Test"], "Frisch, noch nie gesehen. Spielt den 30-Sekunden-Clip.", true],
  ["Testfilm (angefangen)", 2024, ["Test"], "Alice hat 12 Sekunden gesehen.", true],
  ["Testfilm (gesehen)", 2024, ["Test"], "Alice hat ihn ganz gesehen.", true],
  ["Ärger im Paradies", 1999, ["Komödie", "Romanze", "Drama"], "Ein Hotelier in Köln träumt vom Südseeurlaub – und landet bei Müllers im Schwarzwald.", true],
  ["Blade Runner 2049", 2017, ["Science-Fiction", "Drama"], LONG, true],
  ["Das Boot", 1981, ["Kriegsfilm"], "Ein deutsches U-Boot im Atlantik, 1941.", true],
  ["Das Fünfte Element", 1997, ["Science-Fiction", "Action"], "Im 23. Jahrhundert hängt das Schicksal der Erde an einem Taxifahrer.", true],
  ["Der Pate", 1972, ["Drama", "Krimi"], "Der Aufstieg einer Mafia-Familie<br>in New York.<br/><br />Ein Klassiker.", true],
  ["Die Verurteilten", 1994, ["Drama"], "Zwei Häftlinge finden über Jahre Trost und Hoffnung.", true],
  ["Film ohne Cover", 2003, ["Dokumentarfilm"], "Dieser Eintrag hat kein Primärbild auf dem Server.", false],
  ["Film ohne Jahr und Genre", null, [], "", true],
  ["Interstellar", 2014, ["Science-Fiction"], "Eine Reise durch ein Wurmloch auf der Suche nach einer neuen Heimat.", true],
  ["Matrix", 1999, ["Science-Fiction", "Action"], "Ein Hacker entdeckt die wahre Natur seiner Realität.", true],
  ["Öl für die Welt – Die ungekürzte Fassung mit einem sehr langen Titel", 2011, ["Dokumentarfilm", "Geschichte"], "x".repeat(400), true],
  ["Pulp Fiction", 1994, ["Krimi"], "Verschlungene Geschichten aus der Unterwelt von Los Angeles.", true],
  ["Über den Wolken", 1974, ["Drama"], "Ein Pilot, eine Frau – und eine Menge Himmel dazwischen.", true],
  ["Alien", 1979, ["Horror", "Science-Fiction"], "Im Weltall hört dich niemand schreien.", true],
];

// [Name, Jahr, Genres, Inhalt, hatCover, ChildCount]
const SERIES_ROWS = [
  ["Testserie", 2024, ["Test"], "Zwei Staffeln: Folge 1 gesehen, Folge 2 angefangen.", true, 2],
  ["Serie fertig", 2023, ["Test"], "Alles gesehen.", true, 1],
  ["Serie neu", 2025, ["Test"], "Noch nichts gesehen (der Mock nennt dafür kein \"Als Nächstes\").", true, 1],
  ["Breaking Bad", 2008, ["Drama"], "Ein Chemielehrer steigt in die Drogenproduktion ein.", true, 5],
  ["Dark", 2017, ["Mystery", "Drama"], "Das Verschwinden eines Kindes erschüttert eine Kleinstadt.", true, 3],
  ["Einzelstaffel-Serie", 2020, ["Krimi"], "Nur eine Staffel.", true, 1],
  ["Serie ohne Staffelzahl", 2015, ["Fantasy", "Abenteuer"], "ChildCount fehlt komplett.", true, undefined],
  ["Stranger Things", 2016, ["Fantasy"], "Seltsame Dinge geschehen in Hawkins, Indiana.", true, 4],
  ["The Expanse", 2015, ["Science-Fiction"], "Ein Komplott im Sonnensystem steht kurz vor dem Krieg.", false, 6],
  ["Tatort München", 1970, ["Krimi"], "Zwei Kommissare, ein Fall, sonntags um viertel nach acht.", true, 52],
  ["Ärzte ohne Grenzen", 2012, ["Drama"], "Ein Team zwischen Hoffnung und Erschöpfung.", true, 2],
];

const MOVIES = MOVIE_ROWS.map(([name, year, genres, overview, cover], i) => ({
  id: gid("a1", i),
  type: "Movie",
  name,
  year,
  genres,
  overview,
  cover,
}));
const SERIES = SERIES_ROWS.map(([name, year, genres, overview, cover, childCount], i) => ({
  id: gid("b2", i),
  type: "Series",
  name,
  year,
  genres,
  overview,
  cover,
  childCount,
}));

// [Serie (Index), Staffel, Folge, Name, virtuell?]
const EPISODE_ROWS = [
  [0, 1, 1, "Der Anfang"],
  [0, 1, 2, "Die Mitte"],
  [0, 1, 3, "Das Ende der Staffel"],
  [0, 2, 1, "Neue Wege"],
  [0, 2, 2, "Weiter so"],
  [0, 2, 3, "Fehlende Folge", true],
  [0, 0, 1, "Hinter den Kulissen"],
  [1, 1, 1, "Pilotfolge"],
  [1, 1, 2, "Finale"],
  [2, 1, 1, "Erste Folge"],
  [2, 1, 2, "Zweite Folge"],
  [2, 1, 3, "Dritte Folge"],
];
const EPISODES = EPISODE_ROWS.map(([s, season, number, name, virtual], i) => ({
  id: gid("c3", i),
  type: "Episode",
  seriesIndex: s,
  season,
  number,
  name,
  virtual: !!virtual,
  overview: `${name} – Folge ${number} der Staffel ${season}.`,
  cover: !virtual,
}));

const ITEM_BY_ID = new Map();
for (const it of [...MOVIES, ...SERIES, ...EPISODES]) ITEM_BY_ID.set(it.id, it);
const episodesOf = (series) => EPISODES.filter((e) => e.seriesIndex === SERIES.indexOf(series));
const seriesOf = (ep) => SERIES[ep.seriesIndex];

const MANY_MOVIES = Array.from({ length: 412 }, (_, i) => ({
  id: gid("d4", i),
  type: "Movie",
  name: `Massenfilm ${String(i + 1).padStart(3, "0")}`,
  year: 1950 + (i % 70),
  genres: ["Drama"],
  overview: `Test ${i}`,
  cover: i % 3 !== 0,
}));
const MANY_SERIES = Array.from({ length: 350 }, (_, i) => ({
  id: gid("e5", i),
  type: "Series",
  name: `Massenserie ${String(i + 1).padStart(3, "0")}`,
  year: 1950 + (i % 70),
  genres: ["Drama"],
  overview: `Test ${i}`,
  cover: i % 3 !== 0,
  childCount: 3,
}));
for (const it of [...MANY_MOVIES, ...MANY_SERIES]) ITEM_BY_ID.set(it.id, it);

/** Benutzer: Bob ist deaktiviert, hat aber die jüngste Aktivität – er darf nie automatisch gewählt werden. */
const DEFAULT_USERS = [
  { id: "0a11ce00000000000000000000000001", name: "Alice", last: "2026-10-07T20:00:00.0000000Z", disabled: false },
  { id: "0b0b0000000000000000000000000002", name: "Bob", last: "2026-10-08T09:00:00.0000000Z", disabled: true },
  { id: "0ca40100000000000000000000000003", name: "Carol", last: "2026-10-05T10:00:00.0000000Z", disabled: false },
];

/** Wiedergabestände zu Beginn: Alice hat einiges gesehen, Carol einen Film. */
function seedUserData() {
  const data = new Map();
  const alice = DEFAULT_USERS[0].id;
  const carol = DEFAULT_USERS[2].id;
  const set = (user, id, v) => data.set(`${user}|${id}`, v);
  const byName = (name) => MOVIES.find((m) => m.name === name).id;
  set(alice, byName("Testfilm (angefangen)"), { pos: 12 * TICKS, count: 0, played: false, last: "2026-10-06T18:00:00.0000000Z" });
  set(alice, byName("Testfilm (gesehen)"), { pos: 0, count: 1, played: true, last: "2026-10-05T18:00:00.0000000Z" });
  set(alice, byName("Blade Runner 2049"), { pos: 12 * TICKS, count: 0, played: false, last: "2026-10-04T18:00:00.0000000Z" });
  set(alice, byName("Das Boot"), { pos: 0, count: 2, played: true, last: "2026-10-03T18:00:00.0000000Z" });
  set(alice, byName("Alien"), { pos: Math.round(28.5 * TICKS), count: 0, played: false, last: "2026-10-02T18:00:00.0000000Z" });
  set(carol, byName("Testfilm"), { pos: 0, count: 1, played: true, last: "2026-10-01T18:00:00.0000000Z" });
  const ep = (s, season, number) => EPISODES.find((e) => e.seriesIndex === s && e.season === season && e.number === number).id;
  set(alice, ep(0, 1, 1), { pos: 0, count: 1, played: true, last: "2026-09-30T18:00:00.0000000Z" });
  set(alice, ep(0, 1, 2), { pos: 12 * TICKS, count: 0, played: false, last: "2026-10-01T18:00:00.0000000Z" });
  set(alice, ep(1, 1, 1), { pos: 0, count: 1, played: true, last: "2026-09-20T18:00:00.0000000Z" });
  set(alice, ep(1, 1, 2), { pos: 0, count: 1, played: true, last: "2026-09-21T18:00:00.0000000Z" });
  return data;
}

/* Datei-Eigenschaften der beiden "Medien": WebM (Chromium kann es direkt) und MKV (HEVC + DTS: nicht direkt abspielbar). */
const SUBTITLES = [
  { Type: "Subtitle", Index: 3, Codec: "subrip", Language: "ger", DisplayTitle: "Deutsch - SUBRIP - Extern", IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true },
  { Type: "Subtitle", Index: 4, Codec: "webvtt", Language: "eng", DisplayTitle: "English - WEBVTT", IsExternal: false, IsTextSubtitleStream: true, SupportsExternalStream: true },
  { Type: "Subtitle", Index: 5, Codec: "pgssub", Language: "ger", DisplayTitle: "Deutsch - PGSSUB (Bild)", IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: false },
];
const FILES = {
  webm: {
    container: "webm",
    file: "clip.webm",
    mime: "video/webm",
    bitrate: 735_674,
    video: "vp9",
    audio: ["opus", "opus"],
    streams: [
      { Type: "Video", Index: 0, Codec: "vp9", Width: 640, Height: 360, AverageFrameRate: 25, RealFrameRate: 25, BitRate: 600_000, BitDepth: 8, Profile: "Profile 0", PixelFormat: "yuv420p", VideoRange: "SDR", VideoRangeType: "SDR", IsInterlaced: false, DisplayTitle: "360p VP9 SDR", IsDefault: true },
      { Type: "Audio", Index: 1, Codec: "opus", Language: "ger", Title: "Deutsch", DisplayTitle: "Deutsch - Opus - Stereo - Standard", Channels: 2, ChannelLayout: "stereo", SampleRate: 48000, BitRate: 64_000, IsDefault: true },
      { Type: "Audio", Index: 2, Codec: "opus", Language: "eng", Title: "English", DisplayTitle: "English - Opus - Stereo", Channels: 2, ChannelLayout: "stereo", SampleRate: 48000, BitRate: 64_000, IsDefault: false },
      ...SUBTITLES,
    ],
  },
  mkv: {
    container: "mkv",
    file: "clip.mkv",
    mime: "video/x-matroska",
    bitrate: 8_000_000,
    video: "hevc",
    audio: ["dts", "eac3"],
    streams: [
      { Type: "Video", Index: 0, Codec: "hevc", Width: 1920, Height: 1080, AverageFrameRate: 24, RealFrameRate: 24, BitRate: 7_000_000, BitDepth: 10, Profile: "Main 10", Level: 150, PixelFormat: "yuv420p10le", VideoRange: "SDR", VideoRangeType: "SDR", IsInterlaced: false, DisplayTitle: "1080p HEVC Main 10 SDR", IsDefault: true },
      { Type: "Audio", Index: 1, Codec: "dts", Language: "ger", Title: "Deutsch", DisplayTitle: "Deutsch - DTS - 5.1 - Standard", Channels: 6, ChannelLayout: "5.1", SampleRate: 48000, BitRate: 768_000, IsDefault: true },
      { Type: "Audio", Index: 2, Codec: "eac3", Language: "eng", Title: "English", DisplayTitle: "English - E-AC-3 - 5.1", Channels: 6, ChannelLayout: "5.1", SampleRate: 48000, BitRate: 640_000, IsDefault: false },
      ...SUBTITLES,
    ],
  },
};

/* ===================================================== Szenarien und Zustand */

/** Name → [Achse, Wert]. Ein Name stellt nur seine Achse um, die anderen bleiben. */
const SCENARIOS = {
  // Wiedergabe (PlaybackInfo)
  direct: ["playback", "direct"],
  transcode: ["playback", "transcode"],
  nosource: ["playback", "nosource"],
  emptysources: ["playback", "emptysources"],
  notallowed: ["playback", "notallowed"],
  ratelimit: ["playback", "ratelimit"],
  error500: ["playback", "error500"],
  badinfo: ["playback", "badinfo"],
  notranscode: ["playback", "notranscode"],
  slowinfo: ["playback", "slowinfo"],
  // Bibliothek (GET /Items)
  normal: ["library", "normal"],
  many: ["library", "many"],
  badjson: ["library", "badjson"],
  items500: ["library", "items500"],
  html: ["library", "html"],
  noitems: ["library", "noitems"],
  emptyall: ["library", "emptyall"],
  emptyseries: ["library", "emptyseries"],
  slow: ["library", "slow"],
  // Benutzerliste (GET /Users)
  usersok: ["users", "usersok"],
  nousers: ["users", "nousers"],
  users403: ["users", "users403"],
  users500: ["users", "users500"],
  // Benutzerdaten-Pfade: neue Server, alte Server (≤ 10.8), kaputte Server
  modern: ["userdata", "modern"],
  legacy: ["userdata", "legacy"],
  userdata500: ["userdata", "userdata500"],
  userdata404: ["userdata", "userdata404"],
  // Anmeldung: neue Server lehnen X-Emby-Token und api_key ab
  legacyauth: ["auth", "legacyauth"],
  strictauth: ["auth", "strictauth"],
  // Adressen in HLS-Wiedergabelisten
  "hls-relative": ["hls", "hls-relative"],
  "hls-root": ["hls", "hls-root"],
  "hls-absolute": ["hls", "hls-absolute"],
  // Form der TranscodingUrl in PlaybackInfo
  "url-root": ["url", "url-root"],
  "url-rel": ["url", "url-rel"],
};
const DEFAULT_SCENARIO = {
  playback: "direct",
  library: "normal",
  users: "usersok",
  userdata: "modern",
  auth: "legacyauth",
  hls: "hls-relative",
  url: "url-root",
};
const DEFAULT_CONFIG = {
  /** Tonspur, die der Server von sich aus wählt (Stream-Index). */
  defaultAudio: 1,
  /** Untertitel, den der Server von sich aus wählt (-1 = aus). */
  defaultSubtitle: -1,
  /** Künstliche Verzögerung für jede Antwort (ms). */
  delayMs: 0,
  /** 1 = die Quellen-Id (MediaSource.Id) ist nicht die Titel-Id (wie bei Titeln mit mehreren Versionen). */
  altSourceIds: 0,
};

function freshState() {
  return {
    scenario: { ...DEFAULT_SCENARIO },
    config: { ...DEFAULT_CONFIG },
    users: DEFAULT_USERS.map((u) => ({ ...u })),
    userData: seedUserData(),
    log: [],
    seq: 0,
    encodings: new Set(),
    preflights: 0,
  };
}

/* ================================================================= Hilfen */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** Kleines Farbverlauf-PNG (Cover), Farbe aus der ID. */
function coverPng(id, w, h) {
  const seed = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const [r, g, b] = [60 + (seed % 150), 60 + ((seed >> 3) % 150), 60 + ((seed >> 6) % 150)];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    const f = y / h;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r * (1 - f * 0.6));
      raw[o + 1] = Math.round(g * (1 - f * 0.6));
      raw[o + 2] = Math.round(b * (1 - f * 0.6));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csv = (s) => String(s ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const randomHex = (n = 32) => crypto.randomBytes(n / 2).toString("hex");

/** Query als Objekt (Originalschreibweise der Namen; mehrfach vorkommende Namen als Liste). */
function queryObject(url) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}
/** Parameter unabhängig von der Schreibweise des Namens (ASP.NET ist da großzügig). */
function param(url, name) {
  const wanted = name.toLowerCase();
  for (const [k, v] of url.searchParams) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function rewritePlaylist(text, prefix, origin) {
  const fix = (u) => (u.startsWith(`${origin}/`) ? `${origin}${prefix}${u.slice(origin.length)}` : u.startsWith("/") ? `${prefix}${u}` : u);
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("#")) return line.replace(/URI="([^"]*)"/g, (_m, u) => `URI="${fix(u)}"`);
      return line.trim() === "" ? line : fix(line);
    })
    .join("\n");
}

/* =============================================================== Der Server */

/**
 * Startet den Mock. `port: 0` wählt einen freien Port.
 * @param {{ port?: number, host?: string, apiKey?: string, mediaDir?: string, scenario?: string }} [options]
 */
export async function startMockJellyfin(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const mediaDir = options.mediaDir ?? path.join(HERE, "media");
  let state = freshState();
  const applyScenario = (name) => {
    const hit = SCENARIOS[name];
    if (!hit) return false;
    state.scenario[hit[0]] = hit[1];
    return true;
  };
  for (const name of String(options.scenario ?? "").split(",").filter(Boolean)) applyScenario(name);

  /* ---------------------------------------------------------------- Anmeldung */

  function authOf(req, url) {
    const header = String(req.headers.authorization ?? "");
    const fromHeader = /^MediaBrowser\s/i.test(header) ? /Token="([^"]*)"/.exec(header)?.[1] : undefined;
    const legacy = state.scenario.auth === "legacyauth";
    const candidates = [
      ["authorization", fromHeader],
      ["ApiKey", param(url, "ApiKey")],
      ...(legacy
        ? [
            ["x-emby-token", req.headers["x-emby-token"] ?? req.headers["x-mediabrowser-token"]],
            ["api_key", param(url, "api_key")],
          ]
        : []),
    ];
    for (const [via, token] of candidates) {
      if (!token) continue;
      // Neben dem (Administrator-)API-Key gibt es den Token eines normalen Benutzers: gehört zu Alice, ist kein Administrator.
      const userToken = token === USER_TOKEN ? DEFAULT_USERS[0].id : undefined;
      return { ok: token === apiKey || !!userToken, via, token, userToken };
    }
    return { ok: false, via: null, token: undefined };
  }
  /** Client-Angaben aus dem Authorization-Header (der Server liest sie für Sitzungen/Transkodierungen mit). */
  function clientOf(req) {
    const header = String(req.headers.authorization ?? "");
    const get = (k) => new RegExp(`${k}="([^"]*)"`).exec(header)?.[1];
    return { deviceId: get("DeviceId") ?? "mock-server-id", device: get("Device"), client: get("Client"), version: get("Version") };
  }

  /* ------------------------------------------------------------------ Antworten */

  const corsHeaders = (req) => ({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, HEAD, OPTIONS",
    // "Authorization" lässt sich nicht per "*" freigeben – deshalb die gewünschten Header zurückspiegeln.
    "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Authorization, X-Emby-Token, Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type",
    "Access-Control-Max-Age": "600",
  });
  const sendBody = (req, res, status, body, type, extra = {}) => {
    res.writeHead(status, { ...corsHeaders(req), "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const sendJson = (req, res, status, obj) => sendBody(req, res, status, JSON.stringify(obj), "application/json; charset=utf-8");
  const sendText = (req, res, status, text) => sendBody(req, res, status, text, "text/plain; charset=utf-8");
  const noContent = (req, res) => {
    res.writeHead(204, corsHeaders(req));
    res.end();
  };

  /** Datei mit Range-Unterstützung (206 + Content-Range) wie ein echter Server. */
  function sendFile(req, res, file, mime) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendText(req, res, 404, `Datei fehlt: ${path.basename(file)} – make-media.sh ausführen`);
    }
    const size = stat.size;
    const base = { ...corsHeaders(req), "Content-Type": mime, "Accept-Ranges": "bytes", "Last-Modified": stat.mtime.toUTCString(), ETag: `"${size}-${stat.mtimeMs}"` };
    const range = req.headers.range;
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === "" && m[2] === "")) {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
        return res.end();
      }
      if (m[1] === "") {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== "") end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
        return res.end();
      }
      status = 206;
    }
    const headers = { ...base, "Content-Length": end - start + 1, ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) };
    res.writeHead(status, headers);
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  /* ---------------------------------------------------------------------- Daten */

  const userById = (id) => state.users.find((u) => u.id.replace(/-/g, "").toLowerCase() === String(id ?? "").replace(/-/g, "").toLowerCase());
  const udKey = (userId, itemId) => `${userId}|${itemId}`;
  const stored = (userId, itemId) => state.userData.get(udKey(userId, itemId));

  function userDataDto(userId, item) {
    const d = stored(userId, item.id) ?? {};
    return {
      PlaybackPositionTicks: d.pos ?? 0,
      PlayCount: d.count ?? 0,
      IsFavorite: false,
      Played: !!d.played,
      Key: item.id,
      ItemId: item.id,
      ...(d.last ? { LastPlayedDate: d.last } : {}),
      ...(d.pos && item.type !== "Series" ? { PlayedPercentage: Math.round((d.pos / RUN_TICKS) * 1000) / 10 } : {}),
    };
  }
  function seriesUserData(userId, series) {
    const eps = episodesOf(series).filter((e) => !e.virtual && e.season !== 0);
    const unplayed = eps.filter((e) => !stored(userId, e.id)?.played).length;
    return { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: eps.length > 0 && unplayed === 0, UnplayedItemCount: unplayed, Key: series.id, ItemId: series.id };
  }

  function itemDto(item, userId, withUserData) {
    const dto = {
      Name: item.name,
      ServerId: "mock-server-id",
      Id: item.id,
      Type: item.type,
      Overview: item.overview ?? "",
      Genres: item.genres ?? [],
      ImageTags: item.cover ? { Primary: `t${item.id.slice(-4)}` } : {},
      BackdropImageTags: [],
      IsFolder: item.type === "Series",
      MediaType: item.type === "Series" ? undefined : "Video",
      LocationType: item.virtual ? "Virtual" : "FileSystem",
    };
    if (item.type !== "Series") dto.RunTimeTicks = RUN_TICKS;
    if (item.year) dto.ProductionYear = item.year;
    if (item.type === "Series") {
      if (item.childCount !== undefined) dto.ChildCount = item.childCount;
    }
    if (item.type === "Episode") {
      const series = seriesOf(item);
      Object.assign(dto, {
        SeriesId: series.id,
        SeriesName: series.name,
        ParentIndexNumber: item.season,
        IndexNumber: item.number,
        SeasonName: item.season === 0 ? "Specials" : `Staffel ${item.season}`,
      });
    }
    if (withUserData && userId) dto.UserData = item.type === "Series" ? seriesUserData(userId, item) : userDataDto(userId, item);
    return dto;
  }

  const userDto = (u) => ({
    Name: u.name,
    ServerId: "mock-server-id",
    Id: u.id,
    HasPassword: false,
    HasConfiguredPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: u.last,
    LastActivityDate: u.last,
    Policy: { IsAdministrator: u.name === "Alice", IsHidden: false, IsDisabled: u.disabled },
    Configuration: {},
  });

  /* ------------------------------------------------------------------ PlaybackInfo */

  function playbackInfo(req, res, item, body, url, auth, client) {
    const sc = state.scenario.playback;
    const psid = randomHex(32);
    if (sc === "error500") return sendText(req, res, 500, "Internal Server Error");
    if (sc === "badinfo") return sendBody(req, res, 200, '{ "MediaSources": [ {', "application/json; charset=utf-8");
    if (sc === "nosource") return sendJson(req, res, 200, { MediaSources: [], ErrorCode: "NoCompatibleStream" });
    if (sc === "emptysources") return sendJson(req, res, 200, { MediaSources: [], PlaySessionId: psid });
    if (sc === "notallowed") return sendJson(req, res, 200, { MediaSources: [], ErrorCode: "NotAllowed" });
    if (sc === "ratelimit") return sendJson(req, res, 200, { MediaSources: [], ErrorCode: "RateLimitExceeded" });

    const spec = sc === "transcode" || sc === "notranscode" ? FILES.mkv : FILES.webm;
    const msid = state.config.altSourceIds ? md5(`quelle-${item.id}`) : item.id;
    // Wie der echte Server: wer eine Quelle verlangt, bekommt nur sie – gibt es keine mit dieser Id, ist die Liste leer.
    if (body.MediaSourceId && String(body.MediaSourceId).toLowerCase() !== msid.toLowerCase()) {
      return sendJson(req, res, 200, { MediaSources: [], ErrorCode: "NoCompatibleStream" });
    }
    // ... und Tonspur-/Untertitelwunsch gilt nur zusammen mit der Quellen-Id (MediaInfoHelper.SetDeviceSpecificData).
    const honorTracks = !!body.MediaSourceId;
    const prof = body.DeviceProfile ?? {};
    const reasons = new Set();
    const streams = spec.streams.map((s) => ({ ...s, IsForced: false, IsDefault: !!s.IsDefault, IsInterlaced: !!s.IsInterlaced }));
    const audioStreams = streams.filter((s) => s.Type === "Audio");
    const wantAudio = honorTracks && Number.isInteger(body.AudioStreamIndex) ? body.AudioStreamIndex : state.config.defaultAudio;
    const audio = audioStreams.find((s) => s.Index === wantAudio) ?? audioStreams[0];
    const wantSub = honorTracks && body.SubtitleStreamIndex !== undefined && body.SubtitleStreamIndex !== null ? body.SubtitleStreamIndex : state.config.defaultSubtitle;
    const sub = streams.find((s) => s.Type === "Subtitle" && s.Index === wantSub);

    // --- Direktwiedergabe nach dem gesendeten Profil beurteilen (vereinfachte Fassung des echten StreamBuilders) ---
    const profiles = (prof.DirectPlayProfiles ?? []).filter((p) => p.Type === "Video");
    const forContainer = profiles.filter((p) => csv(p.Container).includes(spec.container));
    if (forContainer.length === 0) reasons.add("ContainerNotSupported");
    else {
      if (!forContainer.some((p) => csv(p.VideoCodec).includes(spec.video))) reasons.add("VideoCodecNotSupported");
      if (audio && !forContainer.some((p) => csv(p.AudioCodec).includes(audio.Codec))) reasons.add("AudioCodecNotSupported");
    }
    if (forContainer.length === 0) {
      // Ohne passenden Container wertet der echte Server weiter: ist das Bild/der Ton wenigstens irgendwo erlaubt?
      if (!profiles.some((p) => csv(p.VideoCodec).includes(spec.video))) reasons.add("VideoCodecNotSupported");
      if (audio && !profiles.some((p) => csv(p.AudioCodec).includes(audio.Codec))) reasons.add("AudioCodecNotSupported");
    }
    const noSecondary = (prof.CodecProfiles ?? []).some(
      (cp) => cp.Type === "VideoAudio" && !cp.Codec && (cp.Conditions ?? []).some((c) => c.Property === "IsSecondaryAudio" && c.Condition === "Equals" && c.Value === "false"),
    );
    if (noSecondary && audio && audio.Index !== audioStreams[0].Index) reasons.add("SecondaryAudioNotSupported");
    const maxBitrate = body.MaxStreamingBitrate ?? prof.MaxStreamingBitrate;
    if (maxBitrate && spec.bitrate > maxBitrate) reasons.add("ContainerBitrateExceedsLimit");
    const externalOk = (prof.SubtitleProfiles ?? []).some((p) => p.Method === "External" && ["vtt", "srt", "subrip", "ass", "ssa"].includes(String(p.Format).toLowerCase()));
    const deliveryOf = (s) => (s.IsTextSubtitleStream && externalOk ? "External" : "Encode");
    const burnIn = sub && deliveryOf(sub) === "Encode";
    if (burnIn) reasons.add("SubtitleCodecNotSupported");

    const directPlay = body.EnableDirectPlay !== false && reasons.size === 0;
    const canTranscode =
      sc !== "notranscode" &&
      body.EnableTranscoding !== false &&
      (prof.TranscodingProfiles ?? []).some((t) => t.Type === "Video" && t.Protocol === "hls");

    for (const s of streams) {
      if (s.Type !== "Subtitle") continue;
      s.DeliveryMethod = deliveryOf(s);
      if (s.DeliveryMethod === "External") {
        s.DeliveryUrl = `/Videos/${item.id}/${msid}/Subtitles/${s.Index}/0/Stream.vtt?ApiKey=${auth.token}`;
        s.IsExternalUrl = false;
      }
    }

    const source = {
      Protocol: "File",
      Id: msid,
      Path: `/media/${item.name}.${spec.container}`,
      Type: "Default",
      Container: spec.container,
      Size: 3_000_000,
      Name: item.name,
      IsRemote: false,
      ETag: md5(item.id),
      RunTimeTicks: RUN_TICKS,
      SupportsTranscoding: canTranscode,
      SupportsDirectStream: directPlay,
      SupportsDirectPlay: directPlay,
      IsInfiniteStream: false,
      RequiresOpening: false,
      RequiresClosing: false,
      RequiresLooping: false,
      SupportsProbing: true,
      VideoType: "VideoFile",
      MediaStreams: streams,
      MediaAttachments: [],
      Formats: [],
      Bitrate: spec.bitrate,
      RequiredHttpHeaders: {},
      TranscodingSubProtocol: "http",
      DefaultAudioStreamIndex: audio?.Index,
      DefaultSubtitleStreamIndex: sub ? sub.Index : -1,
      HasSegments: false,
    };

    if (!directPlay && canTranscode) {
      const t = (prof.TranscodingProfiles ?? []).find((p) => p.Type === "Video" && p.Protocol === "hls");
      const q = [
        `DeviceId=${client.deviceId}`,
        `MediaSourceId=${msid}`,
        `VideoCodec=${csv(t.VideoCodec)[0] ?? "h264"}`,
        `AudioCodec=${csv(t.AudioCodec)[0] ?? "aac"}`,
        ...(audio ? [`AudioStreamIndex=${audio.Index}`] : []),
        ...(burnIn ? [`SubtitleStreamIndex=${sub.Index}`] : []),
        "VideoBitrate=600000",
        "AudioBitrate=64000",
        "MaxFramerate=25",
        `PlaySessionId=${psid}`,
        `ApiKey=${auth.token}`,
        "TranscodingMaxAudioChannels=2",
        "RequireAvc=false",
        "EnableAudioVbrEncoding=true",
        `Tag=${source.ETag}`,
        `SegmentContainer=${t.Container}`,
        "MinSegments=1",
        "BreakOnNonKeyFrames=True",
        ...(burnIn ? ["SubtitleMethod=Encode"] : []),
        ...(reasons.size ? [`TranscodeReasons=${[...reasons].join(",")}`] : []),
        ...(body.AllowVideoStreamCopy === false ? ["allowVideoStreamCopy=false"] : []),
        ...(body.AllowAudioStreamCopy === false ? ["allowAudioStreamCopy=false"] : []),
      ];
      const rooted = `/videos/${item.id}/master.m3u8?${q.join("&")}`;
      source.TranscodingUrl = state.scenario.url === "url-rel" ? rooted.slice(1) : rooted;
      source.TranscodingSubProtocol = "hls";
      source.TranscodingContainer = t.Container;
    }
    return sendJson(req, res, 200, { MediaSources: [source], PlaySessionId: psid });
  }

  /* ----------------------------------------------------------------------- HLS */

  /** Welche Tonspur-Variante (hls0/hls1) die URL meint. */
  const hlsVariant = (url) => {
    const idx = Number(param(url, "AudioStreamIndex") ?? state.config.defaultAudio);
    return idx === 2 ? 1 : 0;
  };
  const hlsRef = (style, id, rel, origin) => (style === "hls-root" ? `/videos/${id}/${rel}` : style === "hls-absolute" ? `${origin}/videos/${id}/${rel}` : rel);

  function sendPlaylist(req, res, text, ctx) {
    const body = ctx.proxyPrefix ? rewritePlaylist(text, ctx.proxyPrefix, ctx.origin) : text;
    sendBody(req, res, 200, body, "application/vnd.apple.mpegurl", { "Cache-Control": "no-cache" });
  }

  function hlsRoute(req, res, m, url, ctx) {
    const [, id, rest] = m;
    const style = state.scenario.hls;
    const query = url.search; // "?DeviceId=…" – wird an Unterlisten und Segmente weitergereicht, wie beim echten Server
    if (/^master\.m3u8$/i.test(rest)) {
      const psid = param(url, "PlaySessionId");
      const device = param(url, "DeviceId");
      if (psid && device) state.encodings.add(`${device}|${psid}`);
      const lines = [
        "#EXTM3U",
        '#EXT-X-STREAM-INF:BANDWIDTH=735674,AVERAGE-BANDWIDTH=700000,CODECS="vp09.00.10.08,opus",RESOLUTION=640x360,FRAME-RATE=25.000',
        hlsRef(style, id, `main.m3u8${query}`, ctx.origin),
      ];
      return sendPlaylist(req, res, `${lines.join("\n")}\n`, ctx);
    }
    if (/^main\.m3u8$/i.test(rest)) {
      const v = hlsVariant(url);
      let source;
      try {
        source = fs.readFileSync(path.join(mediaDir, `hls${v}`, "index.m3u8"), "utf8");
      } catch {
        return sendText(req, res, 404, "HLS-Medien fehlen – make-media.sh ausführen");
      }
      const out = [];
      for (const line of source.split(/\r?\n/)) {
        if (line.startsWith("#EXT-X-MAP")) out.push(`#EXT-X-MAP:URI="${hlsRef(style, id, `hls1/main/-1.mp4${query}`, ctx.origin)}"`);
        else if (/^seg(\d+)\.m4s$/.test(line)) out.push(hlsRef(style, id, `hls1/main/${/\d+/.exec(line)[0]}.mp4${query}`, ctx.origin));
        else if (line.trim() !== "") out.push(line);
      }
      return sendPlaylist(req, res, `${out.join("\n")}\n`, ctx);
    }
    const seg = /^hls1\/main\/(-?\d+)\.(mp4|m4s|ts)$/i.exec(rest);
    if (seg) {
      const v = hlsVariant(url);
      const n = Number(seg[1]);
      const file = n < 0 ? "init.mp4" : `seg${n}.m4s`;
      return sendFile(req, res, path.join(mediaDir, `hls${v}`, file), "video/mp4");
    }
    return sendText(req, res, 404, "nicht gefunden");
  }

  /* ---------------------------------------------------------------- Untertitel */

  function subtitleRoute(req, res, index) {
    const names = { 3: "de", 4: "en" };
    if (!names[index]) return sendText(req, res, 400, "Kein Textuntertitel (Bild-Untertitel lassen sich nicht als WebVTT liefern)");
    const lang = names[index];
    const file = path.join(mediaDir, `sub.${lang}.vtt`);
    if (fs.existsSync(file)) return sendFile(req, res, file, "text/vtt; charset=utf-8");
    const cues = Array.from({ length: 6 }, (_, i) => `${i + 1}\n00:00:${String(i * 5).padStart(2, "0")}.000 --> 00:00:${String(i * 5 + 3).padStart(2, "0")}.000\nUntertitel (${lang}) Nr. ${i + 1}\n`);
    return sendBody(req, res, 200, `WEBVTT\n\n${cues.join("\n")}`, "text/vtt; charset=utf-8");
  }

  /* ------------------------------------------------------------- Benutzerdaten */

  function applyUserData(userId, item, patch) {
    const d = { ...(stored(userId, item.id) ?? { pos: 0, count: 0, played: false }) };
    if (typeof patch.PlaybackPositionTicks === "number") d.pos = patch.PlaybackPositionTicks;
    if (typeof patch.Played === "boolean") d.played = patch.Played;
    if (typeof patch.PlayCount === "number") d.count = patch.PlayCount;
    if (typeof patch.LastPlayedDate === "string") d.last = patch.LastPlayedDate;
    state.userData.set(udKey(userId, item.id), d);
  }
  function markPlayed(userId, item, played) {
    const d = { ...(stored(userId, item.id) ?? { pos: 0, count: 0, played: false }) };
    d.played = played;
    d.pos = 0;
    if (played) {
      d.count += 1;
      d.last = new Date().toISOString();
    }
    state.userData.set(udKey(userId, item.id), d);
  }

  /** Antwort für die vier Schreib-Endpunkte, je nach Szenario (neu/alt/kaputt). Gibt true zurück, wenn schon geantwortet wurde. */
  function userdataGate(req, res, variant) {
    const mode = state.scenario.userdata;
    if (mode === "userdata500") return sendText(req, res, 500, "Internal Server Error"), true;
    if (mode === "userdata404") return sendText(req, res, 404, ""), true;
    if (mode === "legacy" && variant === "new-userdata") return sendText(req, res, 404, ""), true;
    if (mode === "legacy" && variant === "new-played") return sendText(req, res, 405, ""), true;
    if (mode !== "legacy" && (variant === "old-userdata" || variant === "old-played")) return sendText(req, res, 404, ""), true;
    return false;
  }

  /* --------------------------------------------------------------- Steuerung */

  async function control(req, res, url) {
    const p = url.pathname.toLowerCase();
    if (p === "/__mock/log") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const match = url.searchParams.get("match");
      const method = url.searchParams.get("method")?.toUpperCase();
      const re = match ? new RegExp(match) : null;
      const list = state.log.filter((e) => e.n > since && (!re || re.test(e.path)) && (!method || e.method === method));
      return sendJson(req, res, 200, list);
    }
    if (p === "/__mock/scenario") {
      const names = String(url.searchParams.get("name") ?? "").split(",").filter(Boolean);
      const unknown = names.filter((n) => !applyScenario(n));
      if (unknown.length) return sendJson(req, res, 400, { error: `Unbekanntes Szenario: ${unknown.join(", ")}`, known: Object.keys(SCENARIOS) });
      return sendJson(req, res, 200, { scenario: state.scenario });
    }
    if (p === "/__mock/config") {
      for (const [k, v] of url.searchParams) {
        if (!(k in DEFAULT_CONFIG)) return sendJson(req, res, 400, { error: `Unbekannte Einstellung: ${k}`, known: Object.keys(DEFAULT_CONFIG) });
        state.config[k] = Number(v);
      }
      return sendJson(req, res, 200, { config: state.config });
    }
    if (p === "/__mock/reset") {
      state = freshState();
      for (const name of String(options.scenario ?? "").split(",").filter(Boolean)) applyScenario(name);
      return sendJson(req, res, 200, { ok: true, scenario: state.scenario });
    }
    if (p === "/__mock/state") {
      return sendJson(req, res, 200, {
        scenario: state.scenario,
        config: state.config,
        users: state.users,
        encodings: [...state.encodings],
        requests: state.log.length,
        preflights: state.preflights,
        userData: Object.fromEntries(state.userData),
      });
    }
    if (p === "/__mock/users" && req.method === "POST") {
      const list = JSON.parse((await readBody(req)) || "[]");
      state.users = list.map((u) => ({ id: u.id, name: u.name, last: u.last, disabled: !!u.disabled }));
      return sendJson(req, res, 200, { users: state.users });
    }
    if (p === "/__mock/userdata" && req.method === "POST") {
      const { userId, itemId, data } = JSON.parse((await readBody(req)) || "{}");
      const item = ITEM_BY_ID.get(itemId);
      if (!item) return sendJson(req, res, 404, { error: "Unbekannter Titel" });
      applyUserData(userId, item, data ?? {});
      return sendJson(req, res, 200, { ok: true });
    }
    return sendJson(req, res, 404, { error: "Unbekannter Steuerbefehl" });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 8 * 1024 * 1024) throw new Error("Körper zu groß");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /* ---------------------------------------------------------------- Verteiler */

  async function handle(req, res) {
    const origin = `http://${req.headers.host ?? `${host}:${actualPort}`}`;
    const url = new URL(req.url, origin);
    if (req.method === "OPTIONS") {
      state.preflights += 1;
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    if (url.pathname.toLowerCase().startsWith("/__mock/")) return control(req, res, url);

    // Proxy-Nachbildung: /p/<Token>/… geht ohne Anmeldung durch (der echte Proxy meldet sich selbst an).
    let pathname = url.pathname;
    let proxyPrefix = null;
    const pm = /^\/p\/([^/]+)(\/.*)?$/.exec(pathname);
    if (pm) {
      proxyPrefix = `/p/${pm[1]}`;
      pathname = pm[2] ?? "/";
    }
    const low = pathname.toLowerCase();

    // --- Protokoll ---
    const auth = proxyPrefix ? { ok: true, via: "proxy", token: apiKey } : authOf(req, url);
    const entry = {
      n: ++state.seq,
      time: new Date().toISOString(),
      method: req.method,
      path: pathname,
      query: queryObject(url),
      auth: auth.via,
      authOk: auth.ok,
      viaProxy: !!proxyPrefix,
      headers: { range: req.headers.range, "content-type": req.headers["content-type"] },
      body: undefined,
      status: 0,
    };
    state.log.push(entry);
    // Ein langer Testlauf (HLS-Segmente!) soll den Speicher nicht füllen: nur die letzten 20 000 Anfragen bleiben.
    if (state.log.length > 20000) state.log.splice(0, state.log.length - 20000);
    res.on("finish", () => {
      entry.status = res.statusCode;
    });
    res.on("close", () => {
      if (!entry.status) entry.status = res.statusCode || 499;
    });

    try {
      if (proxyPrefix && !["GET", "HEAD"].includes(req.method)) return sendText(req, res, 405, "Der Medien-Proxy erlaubt nur GET und HEAD");
      if (state.config.delayMs > 0) await sleep(state.config.delayMs);

      // Ohne Anmeldung offen: Server-Infos und (nach Jellyfin-Vorbild) nichts weiter.
      if (low === "/system/info/public") {
        return sendJson(req, res, 200, { ServerName: "Mock-Jelly", Version: state.scenario.userdata === "legacy" ? "10.8.13" : "10.10.7", ProductName: "Jellyfin Server", Id: "mock-server-id", StartupWizardCompleted: true });
      }
      if (!auth.ok) return sendText(req, res, 401, "Unauthorized");
      const client = clientOf(req);

      // Körper lesen (nur bei POST/DELETE) und protokollieren.
      let body = {};
      if (req.method === "POST" || req.method === "DELETE") {
        const raw = await readBody(req);
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = { __raw: raw };
          }
        }
        entry.body = raw ? body : undefined;
      }
      let m;

      if (low === "/system/info") return sendJson(req, res, 200, { ServerName: "Mock-Jelly", Version: "10.10.7", Id: "mock-server-id" });

      /* --- Benutzer --- */
      if (low === "/users/me" && req.method === "GET") {
        // Wie der echte Server: ein API-Key gehört keinem Benutzer → 400.
        const me = auth.userToken ? userById(auth.userToken) : undefined;
        return me ? sendJson(req, res, 200, userDto(me)) : sendText(req, res, 400, "");
      }
      if (low === "/users" && req.method === "GET") {
        if (auth.userToken) return sendText(req, res, 403, "Forbidden"); // Benutzer-Token: keine Administrator-Rechte
        const mode = state.scenario.users;
        if (mode === "users403") return sendText(req, res, 403, "Forbidden");
        if (mode === "users500") return sendText(req, res, 500, "Internal Server Error");
        return sendJson(req, res, 200, mode === "nousers" ? [] : state.users.map(userDto));
      }

      /* --- Bibliothek --- */
      if (low === "/items" && req.method === "GET") {
        const mode = state.scenario.library;
        if (mode === "items500") return sendText(req, res, 500, "kaputt");
        if (mode === "badjson") return sendBody(req, res, 200, "{ nope <html>", "application/json");
        if (mode === "html") return sendBody(req, res, 200, "<html>Login</html>", "text/html");
        if (mode === "noitems") return sendJson(req, res, 200, { Foo: 1 });
        if (mode === "slow") await sleep(12_000);
        const userId = param(url, "userId");
        const withData = (param(url, "enableUserData") ?? "true") !== "false" && !!userId && !!userById(userId);
        const type = param(url, "IncludeItemTypes");
        const limit = Number(param(url, "Limit") ?? 100000);
        let all = type === "Series" ? (mode === "many" ? MANY_SERIES : SERIES) : MOVIES_FOR(mode);
        if (type !== "Series" && type !== "Movie") all = [];
        if (mode === "emptyall" || (mode === "emptyseries" && type === "Series")) all = [];
        const user = userById(userId);
        // Wie der echte Server nach SortName (mit deutscher Sortierung: "Ä" bei "A") ordnen.
        if (/sortname/i.test(String(param(url, "SortBy") ?? "SortName"))) {
          const desc = String(param(url, "SortOrder") ?? "").toLowerCase() === "descending";
          const collator = new Intl.Collator("de");
          all = [...all].sort((a, b) => (desc ? -1 : 1) * collator.compare(a.name, b.name));
        }
        return sendJson(req, res, 200, { Items: all.slice(0, limit).map((it) => itemDto(it, user?.id, withData)), TotalRecordCount: all.length, StartIndex: 0 });
      }
      if ((m = /^\/items\/([^/]+)$/.exec(low)) && req.method === "GET") {
        // Server ≤ 10.8 kennen nur /Users/{id}/Items/{id}; auf GET /Items/{id} antworten sie mit 405 (dort gibt es nur POST/DELETE).
        if (state.scenario.userdata === "legacy") return sendText(req, res, 405, "");
        const item = ITEM_BY_ID.get(m[1]);
        if (!item) return sendText(req, res, 404, "");
        const user = userById(param(url, "userId"));
        return sendJson(req, res, 200, itemDto(item, user?.id, true));
      }
      if ((m = /^\/users\/([^/]+)\/items\/([^/]+)$/.exec(low)) && req.method === "GET") {
        if (state.scenario.userdata !== "legacy") return sendText(req, res, 404, "");
        const item = ITEM_BY_ID.get(m[2]);
        const user = userById(m[1]);
        if (!item || !user) return sendText(req, res, 404, "");
        return sendJson(req, res, 200, itemDto(item, user.id, true));
      }
      if ((m = /^\/items\/([^/]+)\/images\/primary$/.exec(low)) && req.method === "GET") {
        return sendBody(req, res, 200, coverPng(m[1], 200, 300), "image/png");
      }

      /* --- Serien --- */
      if ((m = /^\/shows\/([^/]+)\/episodes$/.exec(low)) && req.method === "GET") {
        const series = SERIES.find((s) => s.id === m[1]);
        if (!series) return sendText(req, res, 404, "");
        const user = userById(param(url, "userId"));
        const missingFalse = String(param(url, "isMissing")).toLowerCase() === "false";
        const list = episodesOf(series).filter((e) => !(e.virtual && missingFalse));
        return sendJson(req, res, 200, { Items: list.map((e) => itemDto(e, user?.id, true)), TotalRecordCount: list.length, StartIndex: 0 });
      }
      if (low === "/shows/nextup" && req.method === "GET") {
        const user = userById(param(url, "userId"));
        const only = param(url, "seriesId");
        const out = [];
        for (const series of SERIES) {
          if (only && series.id !== only) continue;
          const eps = episodesOf(series).filter((e) => !e.virtual && e.season !== 0).sort((a, b) => a.season - b.season || a.number - b.number);
          let last = -1;
          eps.forEach((e, i) => {
            if (user && stored(user.id, e.id)?.played) last = i;
          });
          // Serien ohne gesehene Folge: leere Antwort (echte Server antworten hier je nach Version leer oder mit Folge 1 –
          // der Client muss mit beidem zurechtkommen).
          if (last >= 0 && last + 1 < eps.length) out.push(eps[last + 1]);
        }
        const limit = Number(param(url, "limit") ?? 100);
        return sendJson(req, res, 200, { Items: out.slice(0, limit).map((e) => itemDto(e, user?.id, true)), TotalRecordCount: out.length, StartIndex: 0 });
      }

      /* --- Wiedergabe --- */
      if ((m = /^\/items\/([^/]+)\/playbackinfo$/.exec(low)) && req.method === "POST") {
        const item = ITEM_BY_ID.get(m[1]);
        if (!item) return sendText(req, res, 404, "");
        // Serien haben keine Quelle: der echte Server meldet "kein kompatibler Stream".
        if (item.type === "Series") return sendJson(req, res, 200, { MediaSources: [], ErrorCode: "NoCompatibleStream" });
        if (state.scenario.playback === "slowinfo") await sleep(3000);
        return playbackInfo(req, res, item, body, url, auth, client);
      }
      if ((m = /^\/videos\/([^/]+)\/stream(?:\.([a-z0-9]+))?$/.exec(low)) && (req.method === "GET" || req.method === "HEAD")) {
        const ext = m[2] ?? "webm";
        const spec = ext === "mkv" ? FILES.mkv : FILES.webm;
        return sendFile(req, res, path.join(mediaDir, spec.file), ext === "webm" || ext === "mkv" ? spec.mime : `video/${ext}`);
      }
      if ((m = /^\/videos\/([^/]+)\/(master\.m3u8|main\.m3u8|hls1\/main\/.+)$/.exec(low)) && (req.method === "GET" || req.method === "HEAD")) {
        return hlsRoute(req, res, m, url, { proxyPrefix, origin });
      }
      if ((m = /^\/videos\/([^/]+)\/([^/]+)\/subtitles\/(\d+)(?:\/(\d+))?\/stream\.([a-z0-9]+)$/.exec(low)) && req.method === "GET") {
        if (m[5] !== "vtt") return sendText(req, res, 400, "Nur WebVTT");
        return subtitleRoute(req, res, Number(m[3]));
      }
      if (low === "/videos/activeencodings" && req.method === "DELETE") {
        const device = param(url, "deviceId");
        const psid = param(url, "playSessionId");
        if (!device || !psid) return sendText(req, res, 400, "deviceId und playSessionId sind Pflicht");
        state.encodings.delete(`${device}|${psid}`);
        return noContent(req, res);
      }

      /* --- Sitzungsmeldungen: mit API-Key ohne Benutzer, speichern also nichts --- */
      if (/^\/sessions\/playing(\/progress|\/stopped)?$/.test(low) && req.method === "POST") {
        if (body.__raw) return sendText(req, res, 400, "Ungültiges JSON");
        if (/stopped$/.test(low) && body.PlaySessionId) {
          // Wie der echte Server: beendet auch die Umwandlung dieser Sitzung.
          state.encodings.delete(`${client.deviceId}|${body.PlaySessionId}`);
        }
        return noContent(req, res);
      }

      /* --- Benutzerdaten (neue und alte Pfade) --- */
      if ((m = /^\/useritems\/([^/]+)\/userdata$/.exec(low)) && req.method === "POST") {
        if (userdataGate(req, res, "new-userdata")) return;
        const item = ITEM_BY_ID.get(m[1]);
        const user = userById(param(url, "userId"));
        if (!item || !user) return sendText(req, res, 404, "");
        if (body.__raw) return sendText(req, res, 400, "Ungültiges JSON");
        applyUserData(user.id, item, body);
        return sendJson(req, res, 200, userDataDto(user.id, item));
      }
      if ((m = /^\/users\/([^/]+)\/items\/([^/]+)\/userdata$/.exec(low)) && req.method === "POST") {
        if (userdataGate(req, res, "old-userdata")) return;
        const item = ITEM_BY_ID.get(m[2]);
        const user = userById(m[1]);
        if (!item || !user) return sendText(req, res, 404, "");
        applyUserData(user.id, item, body);
        return sendJson(req, res, 200, userDataDto(user.id, item));
      }
      if ((m = /^\/userplayeditems\/([^/]+)$/.exec(low)) && (req.method === "POST" || req.method === "DELETE")) {
        if (userdataGate(req, res, "new-played")) return;
        const item = ITEM_BY_ID.get(m[1]);
        const user = userById(param(url, "userId"));
        if (!item || !user) return sendText(req, res, 404, "");
        markPlayed(user.id, item, req.method === "POST");
        return sendJson(req, res, 200, userDataDto(user.id, item));
      }
      if ((m = /^\/users\/([^/]+)\/playeditems\/([^/]+)$/.exec(low)) && (req.method === "POST" || req.method === "DELETE")) {
        if (userdataGate(req, res, "old-played")) return;
        const item = ITEM_BY_ID.get(m[2]);
        const user = userById(m[1]);
        if (!item || !user) return sendText(req, res, 404, "");
        markPlayed(user.id, item, req.method === "POST");
        return sendJson(req, res, 200, userDataDto(user.id, item));
      }

      return sendText(req, res, 404, "nicht gefunden");
    } catch (err) {
      if (!res.headersSent) sendText(req, res, 500, `Mock-Fehler: ${err instanceof Error ? err.message : err}`);
      else res.destroy();
    }
  }

  // Filme je Bibliotheks-Szenario ("many" = 412 Stück für die Abschneide-Meldung).
  function MOVIES_FOR(mode) {
    return mode === "many" ? MANY_MOVIES : MOVIES;
  }

  let actualPort = options.port ?? 0;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Mock-Fehler: ${err instanceof Error ? err.message : err}`);
      } catch {
        // Verbindung schon weg
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  actualPort = server.address().port;

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    apiKey,
    server,
    /** Zugriff auf den Zustand (nur lesen; ändern über die /__mock/-Befehle oder setScenario). */
    get state() {
      return state;
    },
    get log() {
      return state.log;
    },
    setScenario(names) {
      for (const n of String(names).split(",").filter(Boolean)) {
        if (!applyScenario(n)) throw new Error(`Unbekanntes Szenario: ${n}`);
      }
    },
    reset() {
      state = freshState();
      for (const name of String(options.scenario ?? "").split(",").filter(Boolean)) applyScenario(name);
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/* ======================================================================== CLI */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  if (args.includes("--help") || args.includes("-h")) {
    console.log("node server.mjs [--port 18110] [--host 127.0.0.1] [--key abc123] [--media ./media] [--scenario transcode,legacy]");
    process.exit(0);
  }
  const mock = await startMockJellyfin({
    port: Number(arg("port", "18110")),
    host: arg("host", "127.0.0.1"),
    apiKey: arg("key", DEFAULT_API_KEY),
    mediaDir: path.resolve(arg("media", path.join(HERE, "media"))),
    scenario: arg("scenario", ""),
  });
  console.log(`mock-jellyfin läuft auf ${mock.url}  (API-Key: ${mock.apiKey})`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

#!/usr/bin/env node
// Mock-Stremio-Addon für Tests (nur Node, keine Abhängigkeiten, gehört nicht zur App).
// Spricht das offene Addon-Protokoll: manifest.json, catalog, meta, stream – mit offenen CORS-Headern.
//
//   node dev/mock-stremio/server.mjs --port 18120
//
// Als Bibliothek: const mock = await startMockStremio({ port }); mock.url, mock.log, await mock.close()
// Inhalt: Film "Testfilm" (tt9000001), Serie "Testserie" (tt9000002, 2 Staffeln). Die Streams zeigen auf public/demo/demo.webm
// (direkte Adresse), dazu je ein Torrent- und ein YouTube-Stream, die die App ausblenden muss.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// WebM statt MP4: Chromium ohne proprietäre Codecs (Playwright) spielt kein H.264.
const DEMO = path.join(HERE, "../../public/demo/demo.webm");

const manifest = (name) => ({
  id: "dev.jellystation.mock",
  version: "1.0.0",
  name,
  description: "Mock-Addon für JellyStation-Tests",
  types: ["movie", "series"],
  idPrefixes: ["tt9"],
  resources: ["catalog", "meta", "stream"],
  catalogs: [
    { type: "movie", id: "mock-search", name: "Suche", extra: [{ name: "search", isRequired: true }] },
    { type: "movie", id: "mock-movies", name: "Testfilme" },
    { type: "series", id: "mock-series", name: "Testserien" },
  ],
});

const MOVIE = { id: "tt9000001", type: "movie", name: "Testfilm", poster: "", releaseInfo: "2020", genres: ["Test", "Demo"], description: "Ein Film nur zum Testen der Stremio-Anbindung." };
const SERIES = { id: "tt9000002", type: "series", name: "Testserie", poster: "", releaseInfo: "2021–2022", genres: ["Test"], description: "Eine Serie mit zwei Staffeln." };
const videos = [1, 2].flatMap((season) =>
  [1, 2, 3].map((episode) => ({ id: `tt9000002:${season}:${episode}`, title: `Folge ${episode} der Staffel ${season}`, season, episode, released: "2021-05-01T00:00:00.000Z" })),
);

export async function startMockStremio({ port = 0, name = "Mock-Addon" } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    log.push(`${req.method} ${url.pathname}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const json = (obj, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
    const p = decodeURIComponent(url.pathname);
    if (p === "/manifest.json") return json(manifest(name));
    if (p === "/catalog/movie/mock-movies.json") return json({ metas: [MOVIE] });
    if (p === "/catalog/series/mock-series.json") return json({ metas: [SERIES] });
    if (p === "/meta/movie/tt9000001.json") return json({ meta: MOVIE });
    if (p === "/meta/series/tt9000002.json") return json({ meta: { ...SERIES, videos } });
    if (p.startsWith("/stream/")) {
      const base = `http://127.0.0.1:${server.address().port}`;
      return json({
        streams: [
          { name: "Mock 720p", description: "Direkter Link\nTestdatei", url: `${base}/demo.webm` },
          { name: "Torrent", infoHash: "0123456789abcdef0123456789abcdef01234567" },
          { name: "Trailer", ytId: "dQw4w9WgXcQ" },
        ],
      });
    }
    if (p === "/demo.webm") {
      const size = fs.statSync(DEMO).size;
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : size - 1;
        res.writeHead(206, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        return fs.createReadStream(DEMO, { start, end }).pipe(res);
      }
      res.writeHead(200, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Length": size });
      return fs.createReadStream(DEMO).pipe(res);
    }
    json({ err: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}`,
    manifestUrl: `http://127.0.0.1:${actual}/manifest.json`,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--port");
  const mock = await startMockStremio({ port: i >= 0 ? Number(process.argv[i + 1]) : 18120 });
  console.log(`Mock-Stremio läuft: ${mock.manifestUrl}`);
}

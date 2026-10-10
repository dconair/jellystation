// Mock-Server für die Installationstests: spielt die GitHub-API und die Download-Server.
//
//   node mock-github.mjs <port> <routes.json> <log-datei>
//
// routes.json: { "GET /pfad?query": { Antwort }, … }; "{{BASE}}" wird durch http://127.0.0.1:<port> ersetzt.
// Antwort: status (200), headers {…}, json {…} | text "…" | file "/pfad" (relativ zur routes.json),
//          delayMs (vor der Antwort), chunkBytes + chunkMs (langsam in Stücken senden),
//          truncateAt (nur so viele Bytes senden, Content-Length nennt aber die volle Länge, dann Verbindung kappen)
// Unbekannte Pfade → 404 {"message":"Not Found"}. Die Datei wird bei jeder Anfrage neu gelesen.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [portArg, routesFile, logFile] = process.argv.slice(2);
const port = Number(portArg);
const base = `http://127.0.0.1:${port}`;
const dir = path.dirname(path.resolve(routesFile));

function log(line) {
  try { fs.appendFileSync(logFile, line + "\n"); } catch { /* egal */ }
}

function loadRoutes() {
  return JSON.parse(fs.readFileSync(routesFile, "utf8").split("{{BASE}}").join(base));
}

const server = http.createServer((req, res) => {
  log(`${req.method} ${req.url} auth=${req.headers.authorization ? "ja" : "nein"}`);
  let routes;
  try { routes = loadRoutes(); } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("routes.json unlesbar: " + e.message);
    return;
  }
  const r = routes[`${req.method} ${req.url}`] || routes[`${req.method} ${req.url.split("?")[0]}`];
  if (!r) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  const send = () => {
    const status = r.status || 200;
    const headers = { ...(r.headers || {}) };
    if (r.json !== undefined) {
      const body = Buffer.from(JSON.stringify(r.json));
      headers["content-type"] = headers["content-type"] || "application/json";
      headers["content-length"] = String(body.length);
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (r.text !== undefined) {
      const body = Buffer.from(String(r.text));
      headers["content-length"] = String(body.length);
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (r.file) {
      const file = path.resolve(dir, r.file);
      const data = fs.readFileSync(file);
      headers["content-type"] = headers["content-type"] || "application/octet-stream";
      headers["content-length"] = String(data.length);
      res.writeHead(status, headers);
      if (req.method === "HEAD") { res.end(); return; }
      if (r.truncateAt !== undefined) {
        res.write(data.subarray(0, r.truncateAt), () => setTimeout(() => res.destroy(), 50));
        return;
      }
      if (r.chunkBytes) {
        let off = 0;
        const timer = setInterval(() => {
          if (off >= data.length) { clearInterval(timer); res.end(); return; }
          res.write(data.subarray(off, off + r.chunkBytes));
          off += r.chunkBytes;
        }, r.chunkMs || 100);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.end(data);
      return;
    }
    res.writeHead(status, headers);
    res.end();
  };
  if (r.delayMs) setTimeout(send, r.delayMs); else send();
});

server.listen(port, "127.0.0.1", () => {
  log(`listening ${base}`);
});
// zweite Adresse (127.0.0.2): damit Umleitungen auf einen "fremden" Server getestet werden können
const second = http.createServer(server.listeners("request")[0]);
second.on("error", () => { /* egal, wenn 127.0.0.2 nicht geht */ });
second.listen(port, "127.0.0.2");

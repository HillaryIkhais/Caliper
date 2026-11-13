import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSwarm } from "./swarm.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..", "web");
const RUN_DIR = path.join(HERE, "runs", "latest");
const PORT = Number(process.env.CALIPER_PORT ?? 4317);
const HOST = process.env.CALIPER_HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function latestRun(): unknown {
  const file = path.join(RUN_DIR, "run.json");
  if (!fs.existsSync(file)) return { mode: "idle" };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const relative = clean === "" ? "index.html" : clean;
  const file = path.resolve(WEB_DIR, relative);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const index = path.join(WEB_DIR, "index.html");
    if (!fs.existsSync(index)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(fs.readFileSync(index));
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(file));
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  try {
    if (req.method === "GET" && url.startsWith("/api/state")) {
      sendJson(res, 200, latestRun());
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/run")) {
      const run = runSwarm();
      sendJson(res, 200, run);
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/reset")) {
      fs.rmSync(RUN_DIR, { recursive: true, force: true });
      sendJson(res, 200, { mode: "idle" });
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/report/")) {
      const name = url.split("/").pop() ?? "";
      if (!/^attempt-[12]-report\.json$/.test(name)) {
        sendJson(res, 404, { error: "report not found" });
        return;
      }
      const file = path.join(RUN_DIR, name);
      if (!fs.existsSync(file)) {
        sendJson(res, 404, { error: "report not found" });
        return;
      }
      sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
      return;
    }
    if (req.method === "GET") {
      serveStatic(res, url);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CALIPER workbench: http://${HOST}:${PORT}`);
  console.log("Local simulation only. No on-chain transactions are created.");
});

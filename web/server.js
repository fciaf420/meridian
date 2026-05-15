import "../envcrypt.js";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { sendNodeResponse } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const DEFAULT_PORT = 8787;
const port = Number(process.env.PORT || DEFAULT_PORT);
const host = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(parsed.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(distDir, requested);
  const indexPath = path.join(distDir, "index.html");

  if (!filePath.startsWith(path.resolve(distDir))) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : indexPath;
  if (!fs.existsSync(finalPath)) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Web app is not built. Run npm run web:build." }));
    return;
  }

  const ext = path.extname(finalPath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": finalPath === indexPath ? "no-store" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(finalPath).pipe(res);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (parsed.pathname === "/" || !parsed.pathname.startsWith("/api/")) {
    sendStatic(req, res);
    return;
  }
  sendNodeResponse(req, res);
});

server.listen(port, host, () => {
  console.log(`Meridian web app listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; stopping Meridian web API.`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

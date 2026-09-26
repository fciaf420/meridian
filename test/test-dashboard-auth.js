// Dashboard: loopback bind, token-gated chat, same-origin WebSocket upgrades.
process.env.DRY_RUN = "true";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

const { isAllowedOrigin } = await import("../server.js");

test("WebSocket origin: same host or loopback only", () => {
  assert.equal(isAllowedOrigin("http://localhost:3737", "localhost:3737"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3737", "localhost:3737"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", "127.0.0.1:3737"), true, "Vite dev server on loopback");
  assert.equal(isAllowedOrigin("https://evil.example", "localhost:3737"), false);
  assert.equal(isAllowedOrigin("http://192.168.1.50:3737", "localhost:3737"), false);
  assert.equal(isAllowedOrigin("not a url", "localhost:3737"), false);
});

test("chat is token-gated and the server binds to loopback by default", () => {
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(src, /msg\.type === "chat"\) \{\n\s+\/\/ Chat runs the full agent[^\n]*\n\s+if \(!isAuthorized\(ws\)\)/);
  assert.match(src, /const host = process\.env\.DASHBOARD_HOST \|\| "127\.0\.0\.1";/);
  assert.match(src, /server\.listen\(port, host,/);
});

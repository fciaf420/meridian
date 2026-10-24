// test/_bootstrap.js — import FIRST in every test file (before any app module).
// Guarantees a test file run directly (`node --test test/foo.js`) can never read
// or write the checkout's real config/state/logs/knowledge: every redirectable
// path env var is pointed at a fresh temp dir unless the caller already set it
// (test:runtime sets them once for the whole suite).
import fs from "fs";
import os from "os";
import path from "path";

function pin(name) {
  if (!process.env[name]) process.env[name] = fs.mkdtempSync(path.join(os.tmpdir(), `meridian-test-${name.toLowerCase()}-`));
}
pin("MERIDIAN_CONFIG_DIR");
pin("MERIDIAN_DATA_DIR");
pin("MERIDIAN_LOG_DIR");
// Never hit the real instance lock / pid file either.
process.env.MERIDIAN_SKIP_INSTANCE_LOCK ??= "1";

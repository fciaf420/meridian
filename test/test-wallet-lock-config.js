import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("nit: syncWalletLockFromConfig applies exits.walletLockTimeoutSec (hard release) without cycles starting", async () => {
  const wl = await import("../wallet-lock.js");
  const alerts = [];
  wl.setWalletLockOptions({ onAlert: (a) => alerts.push(a.kind) });
  wl.syncWalletLockFromConfig({ exits: { walletLockWarnSec: 0, walletLockTimeoutSec: 0.2 } });
  const t0 = Date.now();
  await wl.withWalletLock(() => new Promise(() => {}), 0, "hung").catch(() => {});
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(alerts.includes("abandoned"));
  wl.syncWalletLockFromConfig({ exits: { walletLockWarnSec: 300, walletLockTimeoutSec: 900 } });
  wl.setWalletLockOptions({ onAlert: null });
});

test("nit: config.js syncs wallet-lock options at load and on config change", () => {
  const src = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.ok((src.match(/syncWalletLockFromConfig\(config\)/g) || []).length >= 3);
});

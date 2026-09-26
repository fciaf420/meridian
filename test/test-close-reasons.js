// Close-reason labels: hard-rule closes record the rule, judgment closes the model's reason.
process.env.DRY_RUN = "true";
import test from "node:test";
import assert from "node:assert/strict";

const { withCloseReason } = await import("../tools/executor.js");
const session = await import("../session.js");

const lookup = (m) => (addr) => m[addr] ?? null;

test("a hard-rule close records the rule", () => {
  const out = withCloseReason({ position_address: "P1" }, lookup({ P1: "rule 5: yield dead" }));
  assert.equal(out._close_reason, "rule 5: yield dead");
});

test("the model's reason is appended to the rule, and 'reason' is not passed on", () => {
  const out = withCloseReason({ position_address: "P1", reason: "fee/TVL collapsed on 1h" }, lookup({ P1: "rule 5: yield dead" }));
  assert.equal(out._close_reason, "rule 5: yield dead — fee/TVL collapsed on 1h");
  assert.equal("reason" in out, false);
});

test("no rule: a judgment reason is recorded as Judgment", () => {
  assert.equal(withCloseReason({ position_address: "P2", reason: "yield dying on 1h" }, lookup({}))._close_reason, "Judgment: yield dying on 1h");
  assert.equal(withCloseReason({ position_address: "P2", reason: "Judgment: opportunity cost" }, lookup({}))._close_reason, "Judgment: opportunity cost");
});

test("an existing _close_reason (watcher / OOR fallback) wins; nothing known → default", () => {
  assert.equal(withCloseReason({ position_address: "P1", _close_reason: "FIXED_TP" }, lookup({ P1: "rule 3" }))._close_reason, "FIXED_TP");
  assert.equal(withCloseReason({ position_address: "P3" }, lookup({}))._close_reason, undefined);
});

test("session holds reasons for one management cycle", () => {
  session.setManagementCloseReasons([["P9", "rule 4: OOR timeout (OOR upside)"]]);
  assert.equal(session.getManagementCloseReason("P9"), "rule 4: OOR timeout (OOR upside)");
  session.clearManagementCloseReasons();
  assert.equal(session.getManagementCloseReason("P9"), null);
});

test("a Telegram close is recorded as a manual owner close", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync(new URL("../telegram-ui.js", import.meta.url), "utf8");
  assert.match(src, /executeTool\("close_position", \{ position_address: params\.position_address, _close_reason: "manual \(owner, Telegram\)" \}\)/);
  assert.equal(withCloseReason({ position_address: "P1", _close_reason: "manual (owner, Telegram)" }, lookup({ P1: "rule 4" }))._close_reason, "manual (owner, Telegram)");
});

// Fee claims sell only the claimed fees of the position's own token (pool token X).
process.env.DRY_RUN = "true";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

const { expectedClaimFeeRaw } = await import("../tools/close-swap.js");
const X = "Tok111111111111111111111111111111111111111";
const pool = { lbPair: { tokenXMint: { toBase58: () => X } } };

test("expected claim amount is the position's claimable token-X fee", () => {
  const pd = { positionData: { feeX: "12345", feeXExcludeTransferFee: "12000", totalXAmount: "999999" } };
  assert.equal(expectedClaimFeeRaw(pool, pd, X), 12000n, "net of transfer fee, liquidity not included");
  assert.equal(expectedClaimFeeRaw(pool, { positionData: { feeX: "500" } }, X), 500n);
});

test("any other mint gets nothing — only the position's own token can be sold", () => {
  const pd = { positionData: { feeX: "12345" } };
  assert.equal(expectedClaimFeeRaw(pool, pd, "Other1111111111111111111111111111111111111"), null);
  assert.equal(expectedClaimFeeRaw(pool, {}, X), null);
});

test("claimFees swaps only pool token X, never SOL, from the balance delta", () => {
  const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function claimFees"), src.indexOf("// ─── Close Position"));
  assert.match(body, /const claimBaseMint = pool\.lbPair\?\.tokenXMint\?\.toBase58\?\.\(\) \?\? null;/);
  assert.match(body, /claimBaseMint !== WSOL_MINT/);
  assert.match(body, /preClaimRaw = \(await getOnchainTokenBalance\(claimBaseMint\)\)\.raw/);
  assert.match(body, /swapBackWithdrawnBase\(\{\s*baseMint: claimBaseMint,[\s\S]*?preRaw: preClaimRaw,\s*expectedRaw: expectedFeeRaw,/);
});

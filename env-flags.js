// env-flags.js — one definition of "DRY_RUN is on", shared by config.js and every reader.
// Accepts true/1/yes/on in any case; anything else (unset, "false", "0", garbage) is LIVE-by-env,
// but config.js writes the normalized "true"/"false" back to process.env on boot.
export const DRY_RUN_TRUTHY = /^(true|1|yes|on)$/i;
export const isTruthyDryRun = (v) => DRY_RUN_TRUTHY.test(String(v ?? "").trim());
export const isDryRun = (env = process.env) => isTruthyDryRun(env.DRY_RUN);

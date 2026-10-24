/* global process, URL */
// Prints the effective config (JSON) of a config loader module: argv[2] = path to the module.
const m = await import(new URL(process.argv[2], `file://${process.cwd()}/`).href);
process.stdout.write(JSON.stringify({ config: m.config, env: { DRY_RUN: process.env.DRY_RUN ?? null, USDC_MODE: process.env.USDC_MODE ?? null, LLM_PROVIDER: process.env.LLM_PROVIDER ?? null, LLM_MODEL: process.env.LLM_MODEL ?? null } }));

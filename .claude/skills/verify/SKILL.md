---
name: verify
description: Verify a Meridian change without touching real funds. Syntax-checks changed JS, runs the offline unit suites, and (only when asked) a short dry-run boot. Use after editing agent, tool, prompt or config code, or when the user says /verify.
---

Verify the current change in Meridian. Everything here is dry-run or offline. Never run `npm start` or `node index.js` without `DRY_RUN=true`.

1. **Syntax.** Run `node --check <file>` on each `.js` file changed vs HEAD (`git diff --name-only HEAD -- '*.js'` plus untracked `.js` files). ESM import errors don't show up here, so step 2 still matters.
2. **Offline suites.** Run both, and report pass/fail counts:
   - `npm run test:runtime` (node:test, no network)
   - `node test/test-usdc-mode.js` (plain assert, forces DRY_RUN)
3. **Targeted check.** If the change touches something neither suite covers (a tool in `tools/`, prompt assembly in `prompt.js`, config resolution), write a throwaway script in the scratchpad that imports the changed module and exercises the changed function with `process.env.DRY_RUN = "true"` set before any import. Don't add it to the repo unless asked.
4. **Dry-run boot (only if the user asks, or $ARGUMENTS contains `boot`).** This calls the configured LLM provider (it costs credits) and polls Telegram. Run `DRY_RUN=true node index.js` in the background, watch the log for about 60s for startup errors and the first cycle, then kill it. Don't run it if another Meridian instance is live on this machine, since the two would fight over Telegram polling.

Suites that hit live services (`npm run test:screen` hits the Meteora API; `npm run test:agent` runs a real LLM loop) are not part of /verify. Run them only on request.

Report what ran, what passed, and anything skipped, with the reason.

#!/bin/bash
# Launch wrapper for the com.meridian.bot LaunchAgent (see ops/README.md).
#
# - cd's into the repo (this script lives in <repo>/ops), so relative paths
#   (state.json, logs/, .env) resolve exactly as they do for `npm start`.
# - Runs `node index.js` (what `npm start` runs) as THIS process via exec, so
#   launchd's SIGTERM reaches node directly and the graceful drain runs. With
#   npm/caffeinate in between, the signal would hit a wrapper instead.
# - caffeinate -is -w <pid> holds the "no idle/system sleep" assertion for
#   exactly as long as the bot's PID lives (exec keeps the PID).
set -euo pipefail

cd "$(dirname "$0")/.."

# launchd starts jobs with a minimal PATH; add the usual node locations.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

caffeinate -is -w $$ &
exec node index.js

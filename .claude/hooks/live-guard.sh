#!/bin/sh
# PreToolUse(Bash) guard: Meridian trades real funds unless DRY_RUN=true.
# Commands that would start the agent live get a permission prompt instead of running silently.
cmd=$(jq -r '.tool_input.command // ""')

case "$cmd" in
  *DRY_RUN=true*) exit 0 ;;
esac

if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])(npm (run )?start|node [^;&|]*index\.js|pm2 (start|restart|reload))'; then
  jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask",
    permissionDecisionReason: "Meridian runs LIVE with real funds unless DRY_RUN=true. Use `npm run dev` for dry-run, or approve to run live."}}'
fi
exit 0

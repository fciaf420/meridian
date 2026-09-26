# Running Meridian under launchd

`com.meridian.bot.plist` is a macOS LaunchAgent that keeps the bot running:

- **Restarts on a crash.** `KeepAlive.SuccessfulExit = false` restarts the bot after any non-zero exit: an uncaught exception or unhandled rejection (the bot logs it, sends a Telegram alert when it can, and exits 1), a forced double-signal exit, or a kill. `ThrottleInterval` limits it to one restart every 30s.
- **Stays stopped after a clean stop.** A graceful SIGTERM drain or Telegram `/stop` exits 0, and launchd leaves the bot down.
- **Drains before exiting.** On SIGTERM the bot stops cron jobs, the PnL watcher, Telegram polling and new deploys. It then waits up to `SHUTDOWN_DRAIN_TIMEOUT_SEC` (default 90) for in-flight closes, deploys, swaps and cycles before it exits. `ExitTimeOut` is 120s, so launchd won't SIGKILL it partway through the drain. A second SIGINT/SIGTERM forces an immediate exit.
- **Keeps the Mac awake.** `ops/run.sh` `cd`s into the repo and `exec`s `node index.js`, the same command `npm start` runs. It does that rather than `caffeinate npm start` so that launchd's SIGTERM reaches node directly and the drain runs. `caffeinate -is -w <pid>` holds the no-sleep assertion for as long as the bot's PID is alive.
- **Log files.** Console output goes to `logs/launchd-out.log` and `logs/launchd-err.log`. The bot's own log is still `logs/agent-YYYY-MM-DD.log`.

The plist hardcodes `/Users/frankciafardini/projects/meridian`. If the repo lives elsewhere, edit the four absolute paths first.

The bot runs live unless `.env` / `user-config.json` say otherwise, exactly like `npm start`.

## Files the bot writes itself

You don't create these. The bot writes them at startup:

| File | Contents |
|---|---|
| `logs/bot.pid` | The bot's PID. It's removed on a graceful exit and left behind after a crash, so check it with `kill -0`. |
| `logs/bot.logpath` | The absolute path of the current `logs/agent-YYYY-MM-DD.log`. It's rewritten when the log rotates at UTC midnight. |

## Install

Run these from the repo root. **Stop the existing `setsid nohup npm start` bot first**, or two bots will trade the same wallet.

```bash
cd /Users/frankciafardini/projects/meridian

# 1. Stop the manually started bot. SIGTERM once and it drains (up to 90s).
pgrep -fl "node index.js"                 # find it; other bots may match too, so
lsof -a -p <pid> -d cwd                   # confirm its cwd is this repo
kill -TERM <pid>                          # drains; later versions write logs/bot.pid
while kill -0 <pid> 2>/dev/null; do sleep 2; done

# 2. Install the agent.
chmod +x ops/run.sh
mkdir -p logs ~/Library/LaunchAgents
cp ops/com.meridian.bot.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.meridian.bot.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.meridian.bot.plist
# RunAtLoad starts it immediately. Check it:
launchctl print "gui/$(id -u)/com.meridian.bot" | grep -E "state|pid|last exit"
```

## Status

```bash
launchctl print "gui/$(id -u)/com.meridian.bot" | grep -E "state|pid|runs|last exit"
kill -0 "$(cat logs/bot.pid)" && echo running
tail -f "$(cat logs/bot.logpath)"          # the bot's log
tail -f logs/launchd-err.log               # crashes and stack traces
grep -E "CRASH_ERROR|SHUTDOWN" "$(cat logs/bot.logpath)"
```

## Restart, stop and uninstall

```bash
# Restart: graceful drain, wait for the exit, then a fresh start.
launchctl kill SIGTERM "gui/$(id -u)/com.meridian.bot"
while kill -0 "$(cat logs/bot.pid 2>/dev/null)" 2>/dev/null; do sleep 2; done
launchctl kickstart "gui/$(id -u)/com.meridian.bot"

# Stop until the next login or bootstrap: graceful drain, and no restart after the clean exit 0.
launchctl kill SIGTERM "gui/$(id -u)/com.meridian.bot"

# Uninstall. bootout sends SIGTERM, so the bot drains; it waits up to ExitTimeOut.
launchctl bootout "gui/$(id -u)/com.meridian.bot"
rm ~/Library/LaunchAgents/com.meridian.bot.plist
```

`launchctl kill SIGTERM` leaves the job loaded, so it starts again at the next login (`RunAtLoad`). Use `bootout` to stop it for good.

To pick up new code, pull it and then run the restart commands above. Prefer those three lines over `kickstart -k`: they wait until the drain has actually finished before starting the new process.

## Dead-man switch (optional)

In-process alerts can't report that the process is gone. For that, set these in `.env`:

```
HEALTHCHECK_URL=https://hc-ping.com/<your-check-uuid>
HEALTHCHECK_EVERY_TICKS=10    # optional; default 10
```

The PnL watcher sends a GET to the URL on its first tick and then every `HEALTHCHECK_EVERY_TICKS` ticks. With the default 30s tick, that's every 5 minutes. Each ping is fire-and-forget with a 5s timeout, so a slow or unreachable endpoint never delays a tick.

With [healthchecks.io](https://healthchecks.io) (free tier):

1. Create a check. Set **Period** to 5 minutes (tick interval × `HEALTHCHECK_EVERY_TICKS`) and **Grace** to about 10 minutes, which covers a restart plus the watcher's first tick.
2. Copy its ping URL (`https://hc-ping.com/<uuid>`) into `HEALTHCHECK_URL`.
3. Add an email, Telegram or phone integration to the check.

Pings stop whenever the watcher stops ticking: the process died, the Mac slept or lost network, the event loop is wedged, or the bot is draining or stopped. The check goes down after Period + Grace. A deliberate stop trips it too, so pause the check in healthchecks.io before planned downtime.

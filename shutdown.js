/**
 * shutdown.js — graceful drain on SIGINT/SIGTERM, and crash handlers.
 *
 * Drain: the first signal stops new work (cron jobs, the PnL watcher, Telegram
 * polling, new deploys) and waits up to `timeoutMs` for in-flight work (closes,
 * deploys, management/screening cycles) to finish, logging what it is still
 * waiting for, then exits 0. A second signal exits immediately (code 1).
 *
 * Crash: uncaughtException / unhandledRejection log the error, try to send an
 * alert (bounded), and exit 1 so a supervisor (ops/com.meridian.bot.plist)
 * restarts the bot. Node already crashes on both by default; this makes the
 * crash visible and the exit code deliberate.
 *
 * Everything is injected so tests can drive it without a real process.
 */

import { log as defaultLog } from "./logger.js";

const DEFAULT_TIMEOUT_MS = 90_000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** SHUTDOWN_DRAIN_TIMEOUT_SEC env (default 90). */
export function drainTimeoutMsFromEnv(env = process.env) {
  const sec = Number(env.SHUTDOWN_DRAIN_TIMEOUT_SEC);
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : DEFAULT_TIMEOUT_MS;
}

/**
 * @param {object} o
 * @param {() => (void|Promise<void>)} o.stopIntake  stop crons/watcher/polling, set the draining flag
 * @param {() => string[]} o.getPending              what is still running, e.g. ["close 7xKX…", "management cycle"]
 * @param {() => Promise<void>} [o.onDrained]         last step before exit (bounded to 5s)
 * @param {(code: number) => void} [o.exit]
 */
export function createShutdownController({
  stopIntake,
  getPending,
  onDrained = null,
  exit = (code) => process.exit(code),
  log = defaultLog,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 1_000,
  logEveryMs = 10_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  let draining = false;
  let exited = false;
  let finished = null;

  function doExit(code) {
    if (exited) return;
    exited = true;
    exit(code);
  }

  async function drain(signal) {
    log("shutdown", `Received ${signal}. Draining: no new work; waiting up to ${Math.round(timeoutMs / 1000)}s for in-flight work. Send the signal again to force exit.`);
    try {
      await stopIntake();
    } catch (e) {
      log("shutdown_error", `stopIntake failed: ${e.message}`);
    }

    const start = now();
    let lastLogged = -Infinity;
    let lastKey = null;
    for (;;) {
      if (exited) return;
      let pending;
      try { pending = getPending() || []; } catch (e) { pending = [`(pending check failed: ${e.message})`]; }
      if (pending.length === 0) {
        log("shutdown", `Drained after ${Math.round((now() - start) / 1000)}s: nothing in flight.`);
        break;
      }
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) {
        log("shutdown_error", `Drain timed out after ${Math.round(elapsed / 1000)}s; still in flight: ${pending.join(", ")}. Exiting anyway.`);
        break;
      }
      const key = pending.join(", ");
      if (key !== lastKey || now() - lastLogged >= logEveryMs) {
        log("shutdown", `Waiting for: ${key} (${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s)`);
        lastKey = key;
        lastLogged = now();
      }
      await sleep(pollMs);
    }

    if (onDrained && !exited) {
      try { await withTimeout(onDrained(), 5_000); } catch (e) { log("shutdown_error", `Final step failed: ${e.message}`); }
    }
    doExit(0);
  }

  /**
   * `force: false` for non-signal triggers (e.g. the REPL's stdin closing), so
   * they start a drain but never count as the "second signal".
   */
  function handleSignal(signal, { force = true } = {}) {
    if (draining) {
      if (force) {
        log("shutdown", `Received ${signal} again during drain: forcing immediate exit.`);
        doExit(1);
      }
      return finished;
    }
    draining = true;
    finished = drain(signal);
    return finished;
  }

  return {
    handleSignal,
    isShuttingDown: () => draining,
    done: () => finished,
  };
}

/**
 * Crash handlers: log, alert (bounded to `alertTimeoutMs`), exit 1.
 * Returns the handler so tests can call it directly.
 */
export function createCrashHandler({
  alert = null,
  exit = (code) => process.exit(code),
  log = defaultLog,
  alertTimeoutMs = 5_000,
}) {
  let crashing = false;
  return async function onCrash(kind, err) {
    if (crashing) return; // a crash while alerting: the first exit wins
    crashing = true;
    const msg = err instanceof Error ? (err.stack || err.message) : String(err);
    try { log("crash_error", `${kind}: ${msg}`); } catch { /* logging must not block the exit */ }
    if (alert) {
      try {
        await withTimeout(alert(`Meridian crashed (${kind}): ${err instanceof Error ? err.message : String(err)}. Exiting 1; the supervisor should restart it.`), alertTimeoutMs);
      } catch { /* best effort */ }
    }
    exit(1);
  };
}

export function installCrashHandlers(opts = {}, proc = process) {
  const onCrash = createCrashHandler(opts);
  proc.on("uncaughtException", (err) => { onCrash("uncaughtException", err); });
  proc.on("unhandledRejection", (reason) => { onCrash("unhandledRejection", reason); });
  return onCrash;
}

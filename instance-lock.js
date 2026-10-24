/**
 * instance-lock.js — single-instance guard backed by the pidfile (logs/bot.pid).
 *
 * Two bots managing one wallet would double-deploy and double-close, so a second
 * `node index.js` must refuse to start while the first is alive. Signal-free by
 * design: liveness is a `kill(pid, 0)` probe (no signal is delivered) plus a
 * command-line identity check, so a stale pidfile left by a crash or reboot
 * (pid recycled by an unrelated process) never blocks a restart.
 *
 * File format is unchanged (`<pid>\n`) so `kill -0 "$(cat logs/bot.pid)"` and the
 * ops docs keep working.
 *
 * Ported from yunus-0x/meridian standalone/runtime.js acquireLock(), with the
 * pid-reuse identity check added. Everything is injectable for tests.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/** True if a process with this pid exists (signal 0 delivers nothing). EPERM = exists. */
export function pidExists(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Command line of a pid via `ps`, or null when it cannot be read. */
export function readCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Is `pid` a live Meridian bot? The pid must exist AND, when its command line is
 * readable, look like this app (node ... index.js). An unreadable command line
 * falls back to "alive" (fail closed: refuse to start rather than double-run).
 */
export function isLiveInstance(pid, { exists = pidExists, command = readCommand, marker = /index\.js/ } = {}) {
  if (!exists(pid)) return false;
  const cmd = command(pid);
  if (cmd == null) return true;
  return marker.test(cmd);
}

/**
 * Take the lock or throw. Returns { release(), reclaimedStale }.
 * Creation uses O_EXCL ('wx'), so two processes racing past the stale check can
 * not both win; the loser re-reads and refuses.
 */
export function acquireInstanceLock(file, {
  pid = process.pid,
  isLive = isLiveInstance,
  log = () => {},
} = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let reclaimedStale = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try { fs.writeFileSync(fd, `${pid}\n`); } finally { fs.closeSync(fd); }
      return { release: () => releaseInstanceLock(file, { pid }), reclaimedStale };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let other = NaN;
    try { other = Number(fs.readFileSync(file, "utf8").trim()); } catch { /* vanished: retry */ }
    if (Number.isInteger(other) && other > 0 && other !== pid && isLive(other)) {
      const err = new Error(`Another Meridian instance is running (pid ${other}, ${file}). Refusing to start a second bot on the same wallet.`);
      err.code = "INSTANCE_LOCKED";
      err.pid = other;
      throw err;
    }
    log(`Removing stale instance lock (pid ${Number.isFinite(other) ? other : "unreadable"} is not a running Meridian)`);
    reclaimedStale = true;
    try { fs.unlinkSync(file); } catch { /* raced with another cleaner */ }
  }
  throw new Error(`Could not acquire instance lock ${file}`);
}

/** Remove the lock only if it still names this pid. */
export function releaseInstanceLock(file, { pid = process.pid } = {}) {
  try {
    if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

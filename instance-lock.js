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


/**
 * True if a process with this pid exists (signal 0 delivers nothing).
 * EPERM means the process EXISTS but belongs to another user, so it counts as
 * existing. Caveat: in sandboxes/containers where kill(pid, 0) returns EPERM for
 * EVERY pid, this reports "exists" for any stale pidfile; isLiveInstance() then
 * falls back to the command-line check, and if `ps` is also unavailable it fails
 * closed (refuses to start). That is deliberate; set MERIDIAN_SKIP_INSTANCE_LOCK=1
 * in such environments (see index.js).
 */
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

/** Working directory of a pid (macOS/Linux via lsof), or null. */
export function readCwd(pid) {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000 });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/** Canonical form for comparing two paths: realpath (symlinks, canonical on-disk casing); null when it cannot be resolved. */
function canon(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}
/**
 * Same file? realpath both sides (symlinks, canonical on-disk casing); on darwin
 * (case-insensitive volumes) also fold case. If either side cannot be resolved
 * (file missing) fall back to a resolved-string compare, case-folded on darwin.
 */
export function samePath(a, b, platform = process.platform) {
  const fold = (p) => (platform === "darwin" ? p.toLowerCase() : p);
  const ca = canon(a), cb = canon(b);
  if (ca != null && cb != null) return fold(ca) === fold(cb);
  return fold(path.resolve(a)) === fold(path.resolve(b));
}

/**
 * Does `cmd` (a `ps` command line) run THIS app's entry script (`entry`, an
 * absolute path, normally process.argv[1])? `ps` shows the argv as typed, so
 * `node index.js` is relative: resolve it against that process's cwd (`cwdOf`).
 * If a relative script cannot be resolved (no cwd), accept it when the basename
 * matches (fail closed). Absent entry -> legacy /index\.js/ match.
 */
export function entryMatches(cmd, pid, { entry = process.argv[1], cwdOf = readCwd } = {}) {
  if (!entry) return /index\.js/.test(cmd);
  const abs = path.resolve(entry);
  const base = path.basename(abs);
  const tokens = cmd.split(/\s+/).filter((t) => t.endsWith(base));
  for (const t of tokens) {
    if (path.isAbsolute(t)) { if (samePath(t, abs)) return true; continue; }
    const cwd = cwdOf(pid);
    if (cwd == null) return true; // cannot verify the relative path: assume it is us
    if (samePath(path.resolve(cwd, t), abs)) return true;
  }
  return false;
}

/**
 * Is `pid` a live Meridian bot? The pid must exist AND, when its command line is
 * readable, run this app's own entry script (derived from process.argv[1], so an
 * unrelated `node .../index.js` after a pid recycle does not look like us). An
 * unreadable command line falls back to "alive" (fail closed: refuse to start
 * rather than double-run). `marker` (RegExp) overrides the identity test.
 */
export function isLiveInstance(pid, { exists = pidExists, command = readCommand, marker = null, entry = process.argv[1], cwdOf = readCwd } = {}) {
  if (!exists(pid)) return false;
  const cmd = command(pid);
  if (cmd == null) return true;
  if (marker) return marker.test(cmd);
  return entryMatches(cmd, pid, { entry, cwdOf });
}

/**
 * Take the lock or throw. Returns { release(), reclaimedStale }.
 * Creation uses O_EXCL ('wx'), so two processes racing past the stale check can
 * not both win; the loser re-reads and refuses.
 */
export function acquireInstanceLock(file, {
  pid = process.pid,
  isLive = isLiveInstance,
  command = readCommand,
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
      const hint = command(other) == null
        ? " (could not read its command line, so it is assumed to be Meridian; if this is a sandbox or container where the pid probe is unreliable, set MERIDIAN_SKIP_INSTANCE_LOCK=1)"
        : "";
      const err = new Error(`Another Meridian instance is running (pid ${other}, ${file}). Refusing to start a second bot on the same wallet.${hint}`);
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

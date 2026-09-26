/**
 * atomic-write.js — crash-safe file writes.
 *
 * writeFileSync() truncates the target first, so a crash, kill or full disk
 * mid-write leaves a half-written (unparseable) file. These helpers write a
 * temp file in the same directory, fsync it, then rename() it over the target:
 * rename is atomic on POSIX filesystems, so readers see either the old file or
 * the new one, never a partial write.
 *
 * The temp file inherits the existing file's permission bits, so a 0600
 * user-config.json (it holds the wallet key) stays 0600.
 */

import fs from "fs";
import path from "path";

let _seq = 0;

export function writeFileAtomicSync(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${_seq++}.tmp`);

  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file: default mode */ }

  let fd = null;
  try {
    fd = fs.openSync(tmp, "w", mode ?? 0o666);
    if (mode != null) fs.fchmodSync(fd, mode); // openSync's mode is masked by umask
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already failing */ } }
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }

  // Persist the rename itself (directory entry). Best effort: not every
  // platform/filesystem allows fsync on a directory handle.
  try {
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best effort */ }
}

/** JSON.stringify(value, null, space) + writeFileAtomicSync. Throws on failure. */
export function writeJsonAtomicSync(file, value, space = 2) {
  writeFileAtomicSync(file, JSON.stringify(value, null, space));
}

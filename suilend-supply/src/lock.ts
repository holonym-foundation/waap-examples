import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RecipeError } from "./errors.js";

export interface LockInfo {
  pid: number;
  host: string;
  token: string;
  startedAt: string;
  command: string;
}

export interface HeldLock {
  readonly info: LockInfo;
  release(): void;
}

export const lockFile = (dir: string) => path.join(dir, "mutation.lock");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof v?.pid === "number" && typeof v?.token === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Journal writes call this: the handle must still own `mutation.lock` (same token on disk).
 * Makes "one mutation owner per state directory" hold at the Journal API, not only in the CLI.
 */
export function assertHeld(dir: string, lock: HeldLock | undefined): void {
  if (!lock?.info?.token || readLock(lockFile(dir))?.token !== lock.info.token) {
    throw new RecipeError("LOCKED", `Journal write refused: this process does not hold ${lockFile(dir)}. Nothing was written.`, {
      lockFile: lockFile(dir),
    });
  }
}

/** A lock whose holder is known to be gone: same host, PID no longer running. */
export function isStale(info: LockInfo | undefined): boolean {
  return !!info && info.host === os.hostname() && !alive(info.pid);
}

/**
 * Exclusive per-state-directory mutation lock: `open(O_CREAT|O_EXCL)` on a local file. Held
 * from the journal check until the final journal write, so two processes can never both pass
 * the check and send. Never waits and never steals: a lock left by a dead process is reported
 * and must be removed explicitly with `journal unlock` (see `removeStaleLock`).
 */
export function acquireLock(dir: string, command: string): HeldLock {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockFile(dir);
  const info: LockInfo = { pid: process.pid, host: os.hostname(), token: randomUUID(), startedAt: new Date().toISOString(), command };
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = readLock(file);
    const stale = isStale(holder);
    throw new RecipeError(
      "LOCKED",
      stale
        ? `A previous run (pid ${holder!.pid}, "${holder!.command}", started ${holder!.startedAt}) ended without releasing ${file}. ` +
            `Run "status" to check its submission, then "journal unlock" to remove the stale lock.`
        : holder
          ? `Another suilend-waap process (pid ${holder.pid} on ${holder.host}, "${holder.command}", started ${holder.startedAt}) ` +
            `is submitting with this state directory. Wait for it to finish; nothing was sent.`
          : `The lock file ${file} exists but cannot be read (another process may be creating it). Nothing was sent.`,
      { lockFile: file, holder, stale },
    );
  }
  try {
    fs.writeSync(fd, JSON.stringify(info));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return {
    info,
    release() {
      if (released) return;
      released = true;
      // Only remove our own lock.
      if (readLock(file)?.token === info.token) fs.rmSync(file, { force: true });
    },
  };
}

/** Remove a lock only if its holder is a dead process on this host. Keeps an audit copy. */
export function removeStaleLock(dir: string): { removed: boolean; holder?: LockInfo; reason: string } {
  const file = lockFile(dir);
  if (!fs.existsSync(file)) return { removed: false, reason: "no lock file" };
  const holder = readLock(file);
  if (!holder) return { removed: false, reason: "lock file is unreadable; inspect and remove it by hand only if no suilend-waap process is running" };
  if (!isStale(holder)) {
    return {
      removed: false,
      holder,
      reason: holder.host !== os.hostname() ? `held from another host (${holder.host}); cannot check it` : `pid ${holder.pid} is still running`,
    };
  }
  fs.renameSync(file, `${file}.removed-${holder.token}`);
  return { removed: true, holder, reason: `pid ${holder.pid} is not running` };
}

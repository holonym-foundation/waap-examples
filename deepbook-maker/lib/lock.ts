/**
 * One maker per account per pool per host — an atomic lock, not a pid file.
 *
 * The old `agent.pid` was written with `writeFileSync` and never checked, so two loops
 * could quote the same manager at once and `stop.ts` could withdraw under a live loop.
 *
 * - **Atomic.** Created with `open(path, 'wx')`: exactly one process can create it.
 * - **Scoped to the account, network and pool**, not to a working directory or a
 *   `STATE_FILE` an operator happened to pick: the path is derived from those, under
 *   `LOCK_DIR` (default `~/.deepbook-maker/locks`). One account quotes a pool from one
 *   place at a time.
 * - **Owned.** The file holds a random token. A process releases only a lock whose token
 *   is its own, so a stop that took over a stale lock cannot be released by the old one.
 * - **Liveness is judged honestly.** Same host: the pid is probed, and its start time is
 *   compared with the one recorded, so a reused pid reads as dead. Another host: unknown
 *   — a pid number means nothing across machines. Unknown and live both refuse.
 * - **Breaking** a lock is allowed only when it is dead on this host and the operator
 *   asked (`--break-stale-lock`). Breaking it never touches state: pending operations
 *   and budgets survive.
 *
 * **Limit:** this is a local file. It does not stop a second machine from trading the
 * same manager. The MVP is single-host by design and says so.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface LockHolder {
	token: string
	pid: number
	host: string
	/** The holder's process start time as `ps -o lstart=` reports it, if known. */
	procStart?: string
	acquiredAt: string
	purpose: string
	key: string
}

export type HolderStatus = 'live' | 'dead' | 'foreign_host' | 'unknown'

export interface LockEnv {
	host: string
	pid: number
	/** Is `pid` running on this host? */
	isAlive: (pid: number) => boolean
	/** Process start time for `pid` on this host, or undefined if it cannot be read. */
	procStart: (pid: number) => string | undefined
	now: () => Date
}

export const realLockEnv: LockEnv = {
	host: os.hostname(),
	pid: process.pid,
	isAlive: (pid) => {
		try {
			process.kill(pid, 0)
			return true
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === 'EPERM'
		}
	},
	procStart: (pid) => {
		try {
			return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || undefined
		} catch {
			return undefined
		}
	},
	now: () => new Date(),
}

export class LockHeldError extends Error {
	constructor(
		readonly holder: LockHolder | undefined,
		readonly status: HolderStatus,
		readonly lockPath: string,
	) {
		super(
			holder
				? `lock ${lockPath} is held by pid ${holder.pid} on ${holder.host} (${holder.purpose}, since ${holder.acquiredAt}); holder is ${status}` +
					(status === 'dead' ? '. It looks stale: rerun with --break-stale-lock to take it over (pending operations and budgets are kept).' : '')
				: `lock ${lockPath} exists but cannot be read; holder is ${status}. Inspect it before removing it by hand.`,
		)
		this.name = 'LockHeldError'
	}
}

export function lockKey(owner: string, network: string, poolKey: string): string {
	return `${network}-${poolKey}-${owner.toLowerCase().replace(/^0x/, '').slice(0, 64)}`
}

export function lockPathFor(dir: string, key: string): string {
	return path.join(dir, `${key}.lock`)
}

export function defaultLockDir(): string {
	return process.env.LOCK_DIR ? path.resolve(process.env.LOCK_DIR) : path.join(os.homedir(), '.deepbook-maker', 'locks')
}

export function readHolder(lockPath: string): LockHolder | undefined {
	try {
		return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockHolder
	} catch {
		return undefined
	}
}

export function holderStatus(h: LockHolder | undefined, env: LockEnv): HolderStatus {
	if (!h || typeof h.pid !== 'number') return 'unknown'
	if (h.host !== env.host) return 'foreign_host'
	if (!env.isAlive(h.pid)) return 'dead'
	if (h.procStart === undefined) return 'live'
	const now = env.procStart(h.pid)
	if (now === undefined) return 'unknown'
	return now === h.procStart ? 'live' : 'dead' // pid reused by another process
}

export interface Lock {
	path: string
	holder: LockHolder
	/** Remove the lock iff it still carries our token. Returns whether it removed it. */
	release: () => boolean
	/** True while the file on disk still carries our token. */
	stillOurs: () => boolean
}

export function acquireLock(args: { dir: string; key: string; purpose: string; breakStale?: boolean; env?: LockEnv }): Lock {
	const env = args.env ?? realLockEnv
	fs.mkdirSync(args.dir, { recursive: true, mode: 0o700 })
	const p = lockPathFor(args.dir, args.key)
	const holder: LockHolder = {
		token: crypto.randomBytes(16).toString('hex'),
		pid: env.pid,
		host: env.host,
		procStart: env.procStart(env.pid),
		acquiredAt: env.now().toISOString(),
		purpose: args.purpose,
		key: args.key,
	}

	const tryCreate = (): boolean => {
		try {
			const fd = fs.openSync(p, 'wx', 0o600)
			try {
				fs.writeSync(fd, JSON.stringify(holder))
				fs.fsyncSync(fd)
			} finally {
				fs.closeSync(fd)
			}
			return true
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
			throw err
		}
	}

	if (!tryCreate()) {
		const existing = readHolder(p)
		const status = holderStatus(existing, env)
		if (!(status === 'dead' && args.breakStale)) throw new LockHeldError(existing, status, p)
		// Take over a dead lock: move it aside atomically, then create ours with 'wx'. If
		// another process raced us to it, one of the two `wx` creates fails and throws.
		const aside = `${p}.stale-${Date.now()}`
		fs.renameSync(p, aside)
		if (readHolder(aside)?.token !== existing?.token) {
			// Someone replaced the stale lock between our read and our rename: put theirs back.
			fs.renameSync(aside, p)
			throw new LockHeldError(readHolder(p), holderStatus(readHolder(p), env), p)
		}
		if (!tryCreate()) throw new LockHeldError(readHolder(p), holderStatus(readHolder(p), env), p)
	}

	const stillOurs = () => readHolder(p)?.token === holder.token
	return {
		path: p,
		holder,
		stillOurs,
		release: () => {
			if (!stillOurs()) return false
			try {
				fs.unlinkSync(p)
				return true
			} catch {
				return false
			}
		},
	}
}

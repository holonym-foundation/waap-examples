/**
 * Durable agent state — versioned, identity-bound, written atomically, never silently lost.
 *
 * ## What went wrong before
 *
 * `agent.ts` used to wrap both the read and the write in `try {} catch {}`. A corrupt
 * `state.json` read as "no state", so a live run with a perfectly good manager would
 * create a second one; an unwritable directory lost the fill cursor and every budget
 * without a word. A restart could therefore reset spending limits and cost basis.
 *
 * ## The contract now
 *
 * - **Read.** A missing file is `{ kind: 'missing' }` — whether that means "fresh" is the
 *   caller's decision (see `classifyStart`), because a missing file next to an existing
 *   manager is a lost history, not a new one. Anything else that fails (unreadable,
 *   corrupt JSON, wrong schema, identity mismatch) THROWS `StateError`. Never a default.
 * - **Write.** Temp file in the same directory → fsync → rename over the target →
 *   fsync the directory. A reader sees the old file or the new one, never half of one.
 *   A failed write THROWS; the loop stops quoting on it.
 * - **Identity.** Every state file names the owner, network, pool and manager it
 *   belongs to. Loading it under a different context throws.
 * - **One transition.** Fill effects, the dedup keys, the cursor and the budgets live in
 *   the same file and are written in one `save`, so a crash cannot persist a cursor
 *   without the fills it walked past (or the reverse) and double-count on restart.
 *
 * ## Version 1 migration
 *
 * v1 was `{ balanceManagerId?, tick, lastMid?, resting, fillCursor? }` with no identity
 * and no budgets. It migrates to v2 with the manager and cursor kept, the identity taken
 * from the loading context, budgets at zero, and `recovery` set: the loop must
 * reconcile orders from chain and backfill fills from the saved cursor before it quotes,
 * and the run report says the budgets start at the migration, not at the manager's
 * first run.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { EventCursor, CollectedFill } from './fills.ts'
import type { RestingOrder } from './quotes.ts'
import { emptyBudget, type BudgetState } from './budget.ts'
import type { PendingOp } from './pending.ts'

export const STATE_VERSION = 2

export interface StateIdentity {
	owner: string
	network: string
	poolKey: string
	poolId: string
	/** A dry run's state is never read by a live run, or the reverse. */
	mode: 'live' | 'dry'
}

export type TrackedOrder = RestingOrder & {
	simulated?: boolean
	/** When our transaction placed it, ms. Absent for adopted orders. */
	placedAtMs?: number
	/** The expiry we set on it, ms. */
	expiresAtMs?: number
}

export interface Valuation {
	atMs: number
	mid: number
	base: number
	quote: number
	/** base × mid + quote, in quote units. */
	valueQuote: number
}

export interface Recovery {
	reason: string
	sinceMs: number
	/** What must be true before quoting resumes. */
	requires: Array<'reconcile_orders' | 'backfill_fills' | 'resolve_pending' | 'operator'>
	detail?: string
}

export interface AgentStateV2 {
	version: 2
	identity: StateIdentity
	balanceManagerId?: string
	/** The current run. A run starts at `agent_start` and ends at confirmed cleanup. */
	runId?: string
	tick: number
	lastMid?: number
	resting: TrackedOrder[]
	fills: {
		cursor: EventCursor | null
		/** Our fills, in the order seen. Also the dedup set. Our own fills are few. */
		ledger: CollectedFill[]
		/** Set once a backfill has reached the head since the last restart. */
		caughtUpAtMs?: number
	}
	pending: PendingOp[]
	budget: BudgetState
	/** Manager value when budgets started. The drawdown trigger is measured against it. */
	startValuation?: Valuation
	recovery?: Recovery
	/** Monotonic counter for client order ids and operation ids. */
	opSeq: number
	/**
	 * Deposits and withdrawals made between restarts of one run, valued at the mark when
	 * drawdown is computed, so a top-up cannot hide a loss (or a withdrawal fake one).
	 */
	transfers?: Array<{ atMs: number; base: number; quote: number; digest?: string }>
	/** Set when an operator skipped a fill backfill: turnover and P&L for this run are incomplete. */
	fillsIncompleteSinceMs?: number
	/** Runs whose cleanup was confirmed: their budgets, kept for the record. */
	closedRuns?: Array<{ runId: string; closedAtMs: number; budget: BudgetState; cleanupDigest?: string }>
}

export class StateError extends Error {
	constructor(
		message: string,
		readonly code: 'unreadable' | 'corrupt' | 'schema' | 'identity' | 'unwritable',
	) {
		super(message)
		this.name = 'StateError'
	}
}

export function newState(identity: StateIdentity, balanceManagerId?: string): AgentStateV2 {
	return {
		version: 2,
		identity,
		balanceManagerId,
		tick: 0,
		resting: [],
		fills: { cursor: null, ledger: [] },
		pending: [],
		budget: emptyBudget(),
		opSeq: 0,
	}
}

export type LoadResult = { kind: 'missing' } | { kind: 'loaded'; state: AgentStateV2; migratedFrom?: number }

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sameIdentity(a: StateIdentity, b: StateIdentity): string | undefined {
	for (const k of ['owner', 'network', 'poolKey', 'poolId', 'mode'] as const) {
		if (a[k] !== b[k]) return `${k}: state has ${a[k]}, this run is ${b[k]}`
	}
	return undefined
}

/**
 * Read and validate. `expected` is the context the caller is running in.
 * `nowMs` is injected so migration timestamps are testable.
 */
export function loadState(file: string, expected: StateIdentity, nowMs: number = Date.now()): LoadResult {
	let raw: string
	try {
		raw = fs.readFileSync(file, 'utf8')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
		throw new StateError(`cannot read ${file}: ${(err as Error).message}`, 'unreadable')
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new StateError(`${file} is not valid JSON (${(err as Error).message}). Refusing to start from an empty state: restore it, or move it aside deliberately and run recovery.`, 'corrupt')
	}
	if (!isObj(parsed)) throw new StateError(`${file} is not a JSON object`, 'schema')

	if (parsed.version === undefined) return { kind: 'loaded', state: migrateV1(parsed, expected, nowMs), migratedFrom: 1 }
	if (parsed.version !== STATE_VERSION) throw new StateError(`${file} has schema version ${String(parsed.version)}; this agent reads ${STATE_VERSION}`, 'schema')

	const s = parsed as unknown as AgentStateV2
	if (!isObj(s.identity)) throw new StateError(`${file} has no identity`, 'schema')
	if (typeof s.tick !== 'number' || !Array.isArray(s.resting) || !isObj(s.fills) || !Array.isArray(s.fills.ledger) || !Array.isArray(s.pending) || !isObj(s.budget) || typeof s.opSeq !== 'number') {
		throw new StateError(`${file} is missing required fields for version ${STATE_VERSION}`, 'schema')
	}
	const mismatch = sameIdentity(s.identity, expected)
	if (mismatch) throw new StateError(`${file} belongs to a different context — ${mismatch}`, 'identity')
	return { kind: 'loaded', state: s }
}

function migrateV1(v1: Record<string, unknown>, identity: StateIdentity, nowMs: number): AgentStateV2 {
	const s = newState(identity, typeof v1.balanceManagerId === 'string' ? v1.balanceManagerId : undefined)
	s.tick = typeof v1.tick === 'number' ? v1.tick : 0
	s.lastMid = typeof v1.lastMid === 'number' ? v1.lastMid : undefined
	s.resting = Array.isArray(v1.resting) ? (v1.resting as TrackedOrder[]) : []
	s.fills.cursor = isObj(v1.fillCursor) ? (v1.fillCursor as unknown as EventCursor) : null
	s.recovery = {
		reason: 'migrated_from_v1',
		sinceMs: nowMs,
		requires: ['reconcile_orders', 'backfill_fills'],
		detail: 'v1 state had no identity, pending operations or budgets. Budgets start at this migration; orders are re-read from chain and fills backfilled from the saved cursor before quoting.',
	}
	return s
}

/**
 * Atomic, durable write. Throws `StateError('unwritable')` on any failure; the temp
 * file is removed if it was created.
 */
export function saveState(file: string, state: AgentStateV2): void {
	const dir = path.dirname(file)
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
	let fd: number | undefined
	try {
		fd = fs.openSync(tmp, 'wx', 0o600)
		fs.writeSync(fd, JSON.stringify(state, null, 2))
		fs.fsyncSync(fd)
		fs.closeSync(fd)
		fd = undefined
		fs.renameSync(tmp, file)
		fsyncDir(dir)
	} catch (err) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd)
			} catch {}
		}
		try {
			fs.unlinkSync(tmp)
		} catch {}
		throw new StateError(`cannot write ${file}: ${(err as Error).message}`, 'unwritable')
	}
}

/** Directory fsync makes the rename durable. Not supported everywhere; EISDIR/EPERM/EINVAL are tolerated. */
function fsyncDir(dir: string): void {
	let fd: number | undefined
	try {
		fd = fs.openSync(dir, 'r')
		fs.fsyncSync(fd)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL' && code !== 'EBADF') throw err
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd)
			} catch {}
		}
	}
}

/**
 * Is a missing state file a fresh start or a lost history?
 *
 * Fresh only when nothing says otherwise: no manager configured anywhere. A manager id
 * in the environment with no state means an earlier run's budgets, cursor and pending
 * work are gone; starting with zeroed budgets would silently reset the loss and gas
 * limits. That needs `adopt` — an explicit operator decision that starts a NEW run whose
 * budgets and starting valuation are measured from the chain now, with the reason
 * logged — or the original state restored.
 */
export function classifyStart(args: {
	load: LoadResult
	envManagerId?: string
	adopt: boolean
}): { kind: 'fresh' } | { kind: 'resume' } | { kind: 'adopt'; managerId: string } | { kind: 'refuse'; reason: string } {
	if (args.load.kind === 'loaded') return { kind: 'resume' }
	if (!args.envManagerId) return { kind: 'fresh' }
	if (args.adopt) return { kind: 'adopt', managerId: args.envManagerId }
	return {
		kind: 'refuse',
		reason: `no state file, but DEEPBOOK_BALANCE_MANAGER_ID=${args.envManagerId} names an existing manager. Its earlier budgets, fill cursor and pending operations are not here. Restore the state file, or set ADOPT_MANAGER=1 to start a new run from what the chain shows now (budgets restart; history before now is not counted).`,
	}
}

/**
 * The manager id a read-only script should use: state and environment must agree
 * (`resolveManager`). A missing file is fine here; a corrupt one throws.
 */
export function peekManagerId(file: string): string | undefined {
	let raw: string
	try {
		raw = fs.readFileSync(file, 'utf8')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw new StateError(`cannot read ${file}: ${(err as Error).message}`, 'unreadable')
	}
	try {
		const v = JSON.parse(raw) as { balanceManagerId?: unknown }
		return typeof v.balanceManagerId === 'string' ? v.balanceManagerId : undefined
	} catch (err) {
		throw new StateError(`${file} is not valid JSON (${(err as Error).message})`, 'corrupt')
	}
}

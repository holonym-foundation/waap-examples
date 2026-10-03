/**
 * The one way every mutating script starts: who we are, which manager, which state, and
 * the lock that says nobody else is acting on this account and pool.
 *
 * `agent.ts`, `deposit.ts` and `stop.ts` all come through here, so they cannot disagree
 * about the manager (`lib/identity.ts`), cannot run at the same time (`lib/lock.ts`), and
 * cannot lose or silently reset state (`lib/state.ts`).
 */
import { resolveManager } from './identity.ts'
import { acquireLock, defaultLockDir, lockKey, type Lock } from './lock.ts'
import { normaliseOnLoad } from './pending.ts'
import { classifyStart, loadState, newState, saveState, type AgentStateV2, type StateIdentity } from './state.ts'
import { ENV_BALANCE_MANAGER_ID, NETWORK, POOL, POOL_KEY, RUN_MODE, STATE_FILE, log, resolveOwner } from './waap.ts'

export interface Context {
	owner: string
	identity: StateIdentity
	state: AgentStateV2
	lock: Lock
	/** Atomic, durable; throws `StateError` on failure. */
	save: () => void
	start: 'fresh' | 'resume' | 'adopt'
	migratedFrom?: number
}

export function lockKeyFor(owner: string): string {
	return lockKey(owner, NETWORK, POOL_KEY) + (RUN_MODE === 'dry' ? '-dry' : '')
}

export async function openContext(opts: { purpose: string; adopt?: boolean; breakStale?: boolean }): Promise<Context> {
	const owner = await resolveOwner()
	const identity: StateIdentity = { owner, network: NETWORK, poolKey: POOL_KEY, poolId: POOL.address, mode: RUN_MODE }

	const lock = acquireLock({ dir: defaultLockDir(), key: lockKeyFor(owner), purpose: opts.purpose, breakStale: opts.breakStale })
	process.on('exit', () => {
		lock.release()
	})
	try {
		const load = loadState(STATE_FILE, identity)
		const start = classifyStart({ load, envManagerId: ENV_BALANCE_MANAGER_ID, adopt: !!opts.adopt })
		if (start.kind === 'refuse') throw new Error(start.reason)
		const state = load.kind === 'loaded' ? load.state : newState(identity, start.kind === 'adopt' ? start.managerId : undefined)
		const m = resolveManager({ stateId: state.balanceManagerId, envId: ENV_BALANCE_MANAGER_ID })
		state.balanceManagerId = m.id
		state.pending = normaliseOnLoad(state.pending)
		const save = () => saveState(STATE_FILE, state)
		save() // prove the state file is writable before anything is sent
		log('info', 'context_opened', {
			purpose: opts.purpose,
			stateFile: STATE_FILE,
			start: start.kind,
			migratedFrom: load.kind === 'loaded' ? (load.migratedFrom ?? null) : null,
			balanceManagerId: state.balanceManagerId ?? null,
			managerSource: m.source,
			lock: lock.path,
			pending: state.pending.map((p) => ({ opId: p.opId, kind: p.kind, status: p.status })),
			recovery: state.recovery ?? null,
		})
		return { owner, identity, state, lock, save, start: start.kind, migratedFrom: load.kind === 'loaded' ? load.migratedFrom : undefined }
	} catch (err) {
		lock.release()
		throw err
	}
}

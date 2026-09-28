/**
 * Which BalanceManager — one answer, for every script.
 *
 * Before: the loop read `state ?? env` (`agent.ts:591`) and deposit/stop read
 * `env ?? state` (`lib/waap.ts:518`). With stale manager A in state and B in the
 * environment, a developer deposited to B, the loop traded A, and stop emptied B while
 * A's orders survived.
 *
 * Now there is one rule: state and environment must agree when both are set. If they
 * disagree, every caller refuses — the operator decides which manager is real.
 */
export interface ManagerResolution {
	id?: string
	source: 'state' | 'env' | 'both' | 'none'
}

export class ManagerConflictError extends Error {
	constructor(
		readonly stateId: string,
		readonly envId: string,
	) {
		super(
			`BalanceManager conflict: state has ${stateId}, DEEPBOOK_BALANCE_MANAGER_ID is ${envId}. ` +
				'Refusing to guess. Unset the environment variable to use the state’s manager, or point STATE_FILE at the state that belongs to the other one.',
		)
		this.name = 'ManagerConflictError'
	}
}

const norm = (s?: string) => (s?.trim() ? s.trim().toLowerCase() : undefined)

export function resolveManager(args: { stateId?: string; envId?: string }): ManagerResolution {
	const s = norm(args.stateId)
	const e = norm(args.envId)
	if (s && e && s !== e) throw new ManagerConflictError(s, e)
	if (s && e) return { id: s, source: 'both' }
	if (s) return { id: s, source: 'state' }
	if (e) return { id: e, source: 'env' }
	return { source: 'none' }
}

/** A Sui object id: 0x followed by 1–64 hex digits. */
export function isObjectId(id: string): boolean {
	return /^0x[0-9a-fA-F]{1,64}$/.test(id)
}

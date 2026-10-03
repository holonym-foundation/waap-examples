import type { PendingOp } from './pending.ts'

export type ManagerSetupTerminal =
	| { ok: true }
	| { ok: false; cause: 'not_submitted' | 'outcome_unknown' | 'id_unreadable'; instruction: string }

/**
 * A live run is successful only after the BalanceManager id is durable in state.
 * This is intentionally pure so every creation outcome can be pinned without signing.
 */
export function managerSetupTerminal(args: { dryRun: boolean; balanceManagerId?: string; pending: PendingOp[] }): ManagerSetupTerminal {
	if (args.dryRun || args.balanceManagerId) return { ok: true }
	const create = args.pending.find((p) => p.kind === 'create_manager')
	if (!create) {
		return { ok: false, cause: 'not_submitted', instruction: 'manager creation was not submitted; fix the refusal, then rerun the setup command' }
	}
	if (!create.digest) {
		return { ok: false, cause: 'outcome_unknown', instruction: 'run `AGENT_DRY_RUN=0 npm run recover`, check the account on an explorer, then attach its digest or declare it not executed; never send a second create while this outcome is unknown' }
	}
	return { ok: false, cause: 'id_unreadable', instruction: 'run `AGENT_DRY_RUN=0 npm run recover` and inspect the recorded digest, then rerun the setup command to recover its manager id; it will not send a second create' }
}

export function terminalExitCode(requested: number, setup: ManagerSetupTerminal): number {
	return setup.ok ? requested : 1
}

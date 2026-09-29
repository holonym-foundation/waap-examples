/**
 * refuse-probe.ts — make the policy engine say no, on purpose, once.
 *
 *   PROBE_SUI=999 npm run refuse-probe
 *
 * It builds one deliberately oversized deposit — 999 SUI by default — through the
 * SAME `signAndSendTx` the loop uses, so nothing about the path is special-cased. Run
 * live, with a daily spend limit set below the probe amount, the enclave should hand
 * the transaction back for the owner's approval rather than signing it. Whatever
 * waap-cli answers, refusal or approval-request or error, is logged verbatim under
 * `policy_probe`.
 *
 * The point is evidence: "the policy asked me" is a claim, and this is the receipt.
 * Run it once mid-run, not on a loop — each probe is a real approval request.
 *
 * In a dry run it proves only that the bytes build and that the send is skipped.
 */
import { Transaction } from '@mysten/sui/transactions'

import {
	AGENT_ID,
	DRY_RUN,
	MANAGER_KEY,
	NETWORK,
	POOL,
	POOL_KEY,
	buildKindBytes,
	fatal,
	getLastSendTxResult,
	getLastSendTxStdout,
	log,
	makeDeepBookClient,
	resolveOwner,
} from './lib/waap.ts'
import { classifyProbeResponse } from './lib/policy.ts'
import { openContext } from './lib/context.ts'
import { sendWithIntent } from './lib/ops.ts'

if (!POOL) {
	console.error(`[${AGENT_ID}] unknown POOL_KEY ${POOL_KEY} on ${NETWORK}`)
	process.exit(1)
}

const PROBE_SUI = Number(process.env.PROBE_SUI ?? '999')

async function main(): Promise<void> {
	// Same lock and manager resolution as every other sender: it cannot run beside the loop.
	const ctx = await openContext({ purpose: 'refuse_probe' })
	const owner = ctx.owner
	const balanceManagerId = ctx.state.balanceManagerId

	log('event', 'refuse_probe_start', {
		network: NETWORK,
		poolKey: POOL_KEY,
		balanceManagerId: balanceManagerId ?? null,
		probeSui: PROBE_SUI,
		dryRun: DRY_RUN,
		owner,
		note: 'one deliberate oversized deposit, built and sent down the ordinary path so the account policy decides',
	})

	if (!balanceManagerId) {
		log('error', 'balance_manager_missing', {
			note: 'the probe deposits into a manager: set DEEPBOOK_BALANCE_MANAGER_ID or run the agent once first',
		})
		process.exit(1)
	}
	if (!(PROBE_SUI > 0)) {
		log('error', 'bad_probe_amount', { probeSui: PROBE_SUI, note: 'PROBE_SUI must be a positive number of SUI' })
		process.exit(1)
	}

	const db = makeDeepBookClient(owner, balanceManagerId)
	const tx = new Transaction()
	// SUI is the quote coin of DEEP/SUI. Deposit, not withdraw: a deposit is the
	// cheapest transaction to have refused — if it is signed after all, the funds land
	// in the manager the loop is already using rather than anywhere new.
	tx.add(db.balanceManager.depositIntoManager(MANAGER_KEY, POOL.quoteCoin, PROBE_SUI))

	const b64 = await buildKindBytes(tx, 'refuse_probe', {
		balanceManagerId,
		coinKey: POOL.quoteCoin,
		amount: PROBE_SUI,
	})
	if (!b64) process.exit(1)

	// Through `sendWithIntent` like every sender (review #9): if the policy lets it through,
	// it is a real deposit and is recorded with its gas. A refusal is the expected answer.
	let digest: string | null = null
	let error: string | null = null
	const out = await sendWithIntent(ctx, {
		kind: 'deposit', b64, runId: ctx.state.runId, proc: 'deposit',
		deposit: { base: 0, quote: PROBE_SUI, adjustDrawdown: !!(ctx.state.runId && ctx.state.startValuation) },
	})
	if (out.status === 'submitted') digest = out.digest
	else if (out.status !== 'dry_run') error = out.error

	// Both channels, whatever the exit code. A refusal that exits nonzero used to lose
	// its stdout entirely — see `lib/waap.ts` `lastSendTxStdout`.
	const response = getLastSendTxStdout()
	const result = getLastSendTxResult()
	// Classified beside the raw text, never instead of it: a nonzero exit is not by
	// itself evidence the POLICY refused. See `lib/policy.ts`.
	const classification = classifyProbeResponse([response, error].filter(Boolean).join('\n'))

	log('event', 'policy_probe', {
		dryRun: DRY_RUN,
		amount: PROBE_SUI,
		coinKey: POOL.quoteCoin,
		digest,
		error,
		exitCode: result?.exitCode ?? null,
		outcome: classification.outcome,
		matched: classification.matched,
		isPolicyEvidence: classification.isPolicyEvidence,
		stderr: result?.stderr ?? null,
		// The whole waap-cli JSON, verbatim. Null in a dry run: waap-cli was never invoked.
		response,
	})

	if (!DRY_RUN && !classification.isPolicyEvidence) {
		log('warn', 'policy_probe_inconclusive', {
			outcome: classification.outcome,
			note: 'a policy check needs an observed ask or rejection. Read policy_probe.response by hand; the exit code alone does not say which layer refused',
		})
	}
}

main().catch(fatal)

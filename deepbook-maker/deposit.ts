/**
 * deposit.ts — move inventory from the wallet into the BalanceManager.
 *
 *   DEPOSIT_SUI=0.5 DEPOSIT_DEEP=25 npm run deposit
 *
 * DeepBook orders are backed by balances inside a `BalanceManager`, not by the wallet.
 * Amounts are human units (0.5 means 0.5 SUI). Both coins go in one PTB.
 *
 * The manager must exist first (the agent's first live tick creates it — README step 3).
 * Deposit takes the same lock as the loop, so it cannot run while the loop is quoting,
 * resolves the manager the same way (state and environment must agree), and records its
 * intent before sending. If a run is still open (a crash left it unfinished), the deposit
 * is recorded as a transfer — if the run's starting value was already measured — so the
 * run's drawdown is not flattered by the top-up. A deposit whose outcome is unknown keeps
 * the run open until `npm run recover` settles it.
 */
import { Transaction } from '@mysten/sui/transactions'

import { openContext } from './lib/context.ts'
import { reconcilePending, sendWithIntent } from './lib/ops.ts'
import { AGENT_ID, DRY_RUN, MANAGER_KEY, NETWORK, POOL, POOL_KEY, buildKindBytes, fatal, log, makeDeepBookClient } from './lib/waap.ts'

if (!POOL) {
	console.error(`[${AGENT_ID}] unknown POOL_KEY ${POOL_KEY} on ${NETWORK}`)
	process.exit(1)
}

function amountFor(coinKey: string): number {
	const n = Number(process.env[`DEPOSIT_${coinKey.toUpperCase()}`] ?? '0')
	return Number.isFinite(n) && n > 0 ? n : 0
}

async function main(): Promise<void> {
	// ADOPT_MANAGER=1: fund an existing manager from a checkout with no state file yet.
	const ctx = await openContext({ purpose: 'deposit', adopt: process.env.ADOPT_MANAGER === '1' })
	const managerId = ctx.state.balanceManagerId
	const deposits = [POOL.baseCoin, POOL.quoteCoin].map((coinKey) => ({ coinKey, amount: amountFor(coinKey) })).filter((d) => d.amount > 0)
	log('event', 'deposit_start', { network: NETWORK, poolKey: POOL_KEY, balanceManagerId: managerId ?? null, deposits, dryRun: DRY_RUN, owner: ctx.owner, runId: ctx.state.runId ?? null })

	if (!managerId) {
		log('error', 'balance_manager_missing', { note: 'create the manager first: AGENT_DRY_RUN=0 MAX_TICKS=1 ./node_modules/.bin/tsx agent.ts' })
		process.exit(1)
	}
	if (deposits.length === 0) {
		log('error', 'nothing_to_deposit', { note: `set DEPOSIT_${POOL.baseCoin} and/or DEPOSIT_${POOL.quoteCoin} in human units` })
		process.exit(1)
	}

	const db = makeDeepBookClient(ctx.owner, managerId)
	const tx = new Transaction()
	for (const d of deposits) tx.add(db.balanceManager.depositIntoManager(MANAGER_KEY, d.coinKey, d.amount))
	const b64 = await buildKindBytes(tx, 'deposit', { balanceManagerId: managerId, deposits })
	if (!b64) process.exit(1)

	const out = await sendWithIntent(ctx, { kind: 'deposit', b64, runId: ctx.state.runId, proc: 'deposit' })
	// Only a deposit AFTER the run's starting value was measured is a transfer; one before it
	// is already inside that value (review #8).
	if (out.status === 'submitted' && ctx.state.runId && ctx.state.startValuation) {
		const base = deposits.find((d) => d.coinKey === POOL.baseCoin)?.amount ?? 0
		const quote = deposits.find((d) => d.coinKey === POOL.quoteCoin)?.amount ?? 0
		ctx.state.transfers = [...(ctx.state.transfers ?? []), { atMs: Date.now(), base, quote, digest: out.digest }]
		ctx.save()
	}
	if (out.status === 'submitted') {
		await new Promise((r) => setTimeout(r, 3_000))
		await reconcilePending(ctx)
	}
	log('event', 'deposit_done', { dryRun: DRY_RUN, outcome: out.status, digest: out.status === 'submitted' ? out.digest : null })
	ctx.lock.release()
	process.exit(out.status === 'submitted' || out.status === 'dry_run' ? 0 : 1)
}

main().catch(fatal)

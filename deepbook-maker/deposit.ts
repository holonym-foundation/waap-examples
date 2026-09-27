/**
 * deposit.ts — move inventory from the wallet into the BalanceManager.
 *
 * DeepBook does not trade out of your wallet. Orders are backed by balances sitting
 * inside a `BalanceManager` shared object, so the funded run needs one deposit before
 * the loop can quote anything.
 *
 *   DEPOSIT_SUI=25 DEPOSIT_DEEP=0 npm run deposit
 *
 * Amounts are human units — 25 means 25 SUI, not 25 MIST. The SDK applies the coin
 * scalar (`depositIntoManager(managerKey, coinKey, amountToDeposit: number)`,
 * `node_modules/@mysten/deepbook-v3/dist/transactions/balanceManager.d.mts:38`).
 *
 * Both deposits go into ONE PTB, so the two coins move under one policy decision
 * rather than two. It leaves through the same `signAndSendTx` as the loop, which
 * means the same dry-run guard: nothing is signed unless AGENT_DRY_RUN=0.
 *
 * The manager has to exist first. Run this after the first `npm run dev` tick has
 * created one — see README §Dry run to live.
 */
import { Transaction } from '@mysten/sui/transactions'

import {
	AGENT_ID,
	DRY_RUN,
	MANAGER_KEY,
	NETWORK,
	POOL,
	POOL_KEY,
	STATE_FILE,
	buildKindBytes,
	fatal,
	log,
	makeDeepBookClient,
	readBalanceManagerId,
	resolveOwner,
	signAndSendTx,
} from './lib/waap.ts'

if (!POOL) {
	console.error(`[${AGENT_ID}] unknown POOL_KEY ${POOL_KEY} on ${NETWORK}`)
	process.exit(1)
}

/** `DEPOSIT_DEEP` and `DEPOSIT_SUI` for the DEEP/SUI pool — one per side of the book. */
function amountFor(coinKey: string): number {
	const raw = process.env[`DEPOSIT_${coinKey.toUpperCase()}`]
	const n = Number(raw ?? '0')
	return Number.isFinite(n) && n > 0 ? n : 0
}

async function main(): Promise<void> {
	const owner = await resolveOwner()
	const balanceManagerId = readBalanceManagerId()

	const deposits = [POOL.baseCoin, POOL.quoteCoin]
		.map((coinKey) => ({ coinKey, amount: amountFor(coinKey) }))
		.filter((d) => d.amount > 0)

	log('event', 'deposit_start', {
		network: NETWORK,
		poolKey: POOL_KEY,
		balanceManagerId: balanceManagerId ?? null,
		deposits,
		dryRun: DRY_RUN,
		owner,
	})

	if (!balanceManagerId) {
		log('error', 'balance_manager_missing', {
			stateFile: STATE_FILE,
			note: 'deposit needs an existing manager: set DEEPBOOK_BALANCE_MANAGER_ID, or run one `npm run dev` tick first so the agent creates and persists one',
		})
		process.exit(1)
	}
	if (deposits.length === 0) {
		log('error', 'nothing_to_deposit', {
			note: `set DEPOSIT_${POOL.baseCoin} and/or DEPOSIT_${POOL.quoteCoin} to a positive amount in human units`,
		})
		process.exit(1)
	}

	const db = makeDeepBookClient(owner, balanceManagerId)
	const tx = new Transaction()
	for (const d of deposits) {
		tx.add(db.balanceManager.depositIntoManager(MANAGER_KEY, d.coinKey, d.amount))
	}

	const b64 = await buildKindBytes(tx, 'deposit', {
		balanceManagerId,
		deposits,
		coins: deposits.length,
	})
	if (!b64) process.exit(1)

	const digest = await signAndSendTx(b64, 'deposit')
	if (digest) log('event', 'tx_submitted', { kind: 'deposit', digest, deposits })
	log('event', 'deposit_done', { dryRun: DRY_RUN, digest: digest ?? null })
}

main().catch(fatal)

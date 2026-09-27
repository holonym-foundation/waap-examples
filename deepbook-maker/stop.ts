/**
 * stop.ts — wind the maker down: pull every resting order, then empty the manager.
 *
 *   npm run stop
 *
 * One PTB, in this order:
 *   1. `cancelAllOrders(poolKey, managerKey)` — everything this manager has on the
 *      DEEP/SUI book, in one call, whatever `state.json` thinks is resting
 *      (`node_modules/@mysten/deepbook-v3/dist/transactions/deepbook.d.mts:81`)
 *   2. `withdrawAllFromManager(managerKey, coinKey, recipient)` for the base coin and
 *      then the quote coin (`.../balanceManager.d.mts:55`)
 *
 * Cancel before withdraw: a resting order's collateral is locked inside the manager,
 * so withdrawing first leaves it behind.
 *
 * Same `signAndSendTx` as the loop, so the same dry-run guard applies.
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
	ZERO_ADDRESS,
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

async function main(): Promise<void> {
	const owner = await resolveOwner()
	// Where the withdrawn coins land. Defaults to the agent's own wallet; override
	// only if you want them somewhere else.
	const recipient = process.env.WITHDRAW_RECIPIENT?.trim() || owner
	const balanceManagerId = readBalanceManagerId()

	log('event', 'stop_start', {
		network: NETWORK,
		poolKey: POOL_KEY,
		balanceManagerId: balanceManagerId ?? null,
		recipient,
		coins: [POOL.baseCoin, POOL.quoteCoin],
		dryRun: DRY_RUN,
		owner,
	})

	if (!balanceManagerId) {
		log('error', 'balance_manager_missing', {
			stateFile: STATE_FILE,
			note: 'nothing to stop: no manager in state and none in DEEPBOOK_BALANCE_MANAGER_ID',
		})
		process.exit(1)
	}
	if (recipient === ZERO_ADDRESS) {
		// Only reachable in a dry run with no session, where nothing is signed and the
		// bytes are thrown away. A live run resolves a real address or fails in whoami.
		log('warn', 'recipient_is_zero_address', {
			note: 'dry run with no session; the withdraw is built against the zero address for byte-length purposes only',
		})
	}

	const db = makeDeepBookClient(owner, balanceManagerId)
	const tx = new Transaction()
	tx.add(db.deepBook.cancelAllOrders(POOL_KEY, MANAGER_KEY))
	tx.add(db.balanceManager.withdrawAllFromManager(MANAGER_KEY, POOL.baseCoin, recipient))
	tx.add(db.balanceManager.withdrawAllFromManager(MANAGER_KEY, POOL.quoteCoin, recipient))

	const b64 = await buildKindBytes(tx, 'stop', {
		balanceManagerId,
		recipient,
		cancelAll: true,
		withdraws: [POOL.baseCoin, POOL.quoteCoin],
	})
	if (!b64) process.exit(1)

	const digest = await signAndSendTx(b64, 'stop')
	if (digest) log('event', 'tx_submitted', { kind: 'stop', digest })
	log('event', 'stop_done', { dryRun: DRY_RUN, digest: digest ?? null })
}

main().catch(fatal)

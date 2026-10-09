/**
 * measure-shapes — what each transaction SHAPE the loop submits actually costs.
 *
 *   SIM_SENDER=0x… DEEPBOOK_BALANCE_MANAGER_ID=0x… npm run measure:shapes
 *
 * ## Why this exists, and what it replaces
 *
 * The first gas measurement covered one shape — place bid + place ask + settle — and a budget
 * was then built as `ticks × requote-rate × that number`. Both halves were wrong.
 *
 * There is no requote rate. `agent.ts` has exactly two early returns in a tick
 * (`balance_manager_missing` and `tx_build_failed`); everything else reaches
 * `withdrawSettledAmounts` and `signAndSendTx`. **Every tick submits a transaction.**
 * Keeping an order inside `REQUOTE_TOLERANCE_BPS` changes what is IN the PTB, not
 * whether one is sent — so widening the tolerance saves the cancel and the place, and
 * saves nothing else.
 *
 * What it does change is which shape is submitted, and the shapes are not close to each
 * other in cost. So the budget is `Σ (count of each shape × that shape's cost)`, and
 * this script measures the costs.
 *
 * Every row is an RPC `dryRunTransactionBlock` on **unsigned** bytes: no key, no
 * signature, nothing submitted, waap-cli never invoked.
 *
 * ## Net and gross
 *
 * `net = computation + storage − rebate` is what leaves the wallet for good.
 * `gross = computation + storage` is charged before the rebate returns. The measured
 * gas BUDGET on this recipe's five real mainnet submissions tracked net, not gross
 * (place1: budget 0.005170 against net 0.005080, gross 0.071795), so gross is not the
 * funding constraint — but it is reported because a budget that only ever saw net would
 * have no way to notice if that changed.
 */
import 'dotenv/config'

import { DeepBookClient, mainnetPools, testnetPools } from '@mysten/deepbook-v3'
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { Transaction } from '@mysten/sui/transactions'

const NETWORK = (process.env.NETWORK ?? 'mainnet') as 'mainnet' | 'testnet'
const SUI_RPC = process.env.SUI_RPC ?? 'https://sui-rpc.publicnode.com'
const POOL_KEY = process.env.POOL_KEY ?? 'DEEP_SUI'
const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? '20')
const ORDER_SIZE = Number(process.env.ORDER_SIZE ?? '100')
const DEPOSIT_SUI = Number(process.env.DEPOSIT_SUI ?? '2.5')
const MANAGER_KEY = 'MAKER'

const SIM_SENDER = process.env.SIM_SENDER?.trim()
const BALANCE_MANAGER_ID = process.env.DEEPBOOK_BALANCE_MANAGER_ID?.trim()

if (!SIM_SENDER) {
	console.error('SIM_SENDER is required — a Sui address that holds SUI to pay the simulated gas.')
	process.exit(1)
}

const sui = new SuiJsonRpcClient({ url: SUI_RPC, network: NETWORK })
const POOLS = NETWORK === 'mainnet' ? mainnetPools : testnetPools
const POOL = POOLS[POOL_KEY]

const db = new DeepBookClient({
	client: sui,
	address: SIM_SENDER,
	network: NETWORK,
	balanceManagers: BALANCE_MANAGER_ID ? { [MANAGER_KEY]: { address: BALANCE_MANAGER_ID } } : {},
})

const MIST = 1e9

interface Row {
	shape: string
	when: string
	status: string
	computation: string
	storage: string
	rebate: string
	netSui: string
	grossSui: string
	error: string
}

async function simulate(shape: string, when: string, build: (tx: Transaction) => void): Promise<Row> {
	const row: Row = { shape, when, status: '—', computation: '—', storage: '—', rebate: '—', netSui: '—', grossSui: '—', error: '' }
	try {
		const tx = new Transaction()
		tx.setSender(SIM_SENDER!)
		build(tx)
		const bytes = await tx.build({ client: sui })
		const res = await sui.dryRunTransactionBlock({ transactionBlock: bytes })
		const g = res.effects.gasUsed
		const computation = BigInt(g.computationCost)
		const storage = BigInt(g.storageCost)
		const rebate = BigInt(g.storageRebate)
		row.status = res.effects.status.status
		row.computation = computation.toString()
		row.storage = storage.toString()
		row.rebate = rebate.toString()
		row.netSui = (Number(computation + storage - rebate) / MIST).toFixed(9)
		row.grossSui = (Number(computation + storage) / MIST).toFixed(9)
		if (res.effects.status.error) row.error = res.effects.status.error
	} catch (err) {
		row.status = 'build_or_rpc_error'
		row.error = String(err).slice(0, 220).replace(/\|/g, '\\|').replace(/\n/g, ' ')
	}
	return row
}

async function main() {
	const l2 = await db.getLevel2TicksFromMid(POOL_KEY, 5)
	const mid = (l2.bid_prices[0] + l2.ask_prices[0]) / 2
	const half = SPREAD_BPS / 2 / 10_000
	const params = await db.poolBookParams(POOL_KEY)
	const t = params.tickSize
	const bid = Number((Math.floor((mid * (1 - half)) / t) * t).toFixed(8))
	const ask = Number((Math.ceil((mid * (1 + half)) / t) * t).toFixed(8))

	// Real resting order ids for this manager, so the cancel rows are cancels of orders
	// that exist rather than of ids the chain would reject.
	let openOrders: string[] = []
	try {
		openOrders = BALANCE_MANAGER_ID ? await db.accountOpenOrders(POOL_KEY, MANAGER_KEY) : []
	} catch (err) {
		console.error(`accountOpenOrders failed: ${String(err).slice(0, 160)}`)
	}

	const place = (tx: Transaction, isBid: boolean, id: string) =>
		tx.add(
			db.deepBook.placeLimitOrder({
				poolKey: POOL_KEY,
				balanceManagerKey: MANAGER_KEY,
				clientOrderId: id,
				price: isBid ? bid : ask,
				quantity: ORDER_SIZE,
				isBid,
			}),
		)
	const settle = (tx: Transaction) => tx.add(db.deepBook.withdrawSettledAmounts(POOL_KEY, MANAGER_KEY))
	const cancel = (tx: Transaction, orderId: string) => tx.add(db.deepBook.cancelLiveOrder(POOL_KEY, MANAGER_KEY, orderId))

	const rows: Row[] = []

	rows.push(await simulate('S0 settle only (no cancel, no place)', 'every tick whose orders stayed inside tolerance', (tx) => settle(tx)))
	rows.push(await simulate('S1 place 1 + settle', 'a bid-only tick that had nothing resting', (tx) => { place(tx, true, '1'); settle(tx) }))
	rows.push(await simulate('S2 place 2 + settle', 'the first two-sided tick after DEEP arrives', (tx) => { place(tx, true, '1'); place(tx, false, '2'); settle(tx) }))
	if (openOrders[0]) {
		rows.push(await simulate('S3 cancel 1 + place 1 + settle', 'a one-sided requote', (tx) => { cancel(tx, openOrders[0]); place(tx, true, '1'); settle(tx) }))
	}
	if (openOrders[1]) {
		rows.push(
			await simulate('S4 cancel 2 + place 2 + settle', 'a two-sided requote', (tx) => {
				cancel(tx, openOrders[0])
				cancel(tx, openOrders[1])
				place(tx, true, '1')
				place(tx, false, '2')
				settle(tx)
			}),
		)
	}
	if (openOrders[0]) {
		rows.push(await simulate('S5 cancel 1 + settle', 'a side withdrawn because it can no longer be backed', (tx) => { cancel(tx, openOrders[0]); settle(tx) }))
	}
	rows.push(await simulate('S6 create BalanceManager', 'once, only if state.json has no manager', (tx) => { tx.add(db.balanceManager.createAndShareBalanceManager()) }))
	rows.push(await simulate(`S7 deposit ${DEPOSIT_SUI} SUI`, 'once, before the run', (tx) => { tx.add(db.balanceManager.depositIntoManager(MANAGER_KEY, POOL.quoteCoin, DEPOSIT_SUI)) }))
	rows.push(
		await simulate('S8 stop: cancelAll + withdraw both coins', 'once, at the end — the cleanup reserve', (tx) => {
			tx.add(db.deepBook.cancelAllOrders(POOL_KEY, MANAGER_KEY))
			tx.add(db.balanceManager.withdrawAllFromManager(MANAGER_KEY, POOL.baseCoin, SIM_SENDER!))
			tx.add(db.balanceManager.withdrawAllFromManager(MANAGER_KEY, POOL.quoteCoin, SIM_SENDER!))
		}),
	)
	rows.push(await simulate('S9 refuse-probe deposit 999 SUI', 'once, mid-run (expected to be refused, not signed)', (tx) => { tx.add(db.balanceManager.depositIntoManager(MANAGER_KEY, POOL.quoteCoin, 999)) }))

	console.log(`network: ${NETWORK} · rpc: ${SUI_RPC} · pool: ${POOL_KEY} (${POOL.address})`)
	console.log(`sender: ${SIM_SENDER} · balanceManager: ${BALANCE_MANAGER_ID ?? '(none)'} · openOrders: ${openOrders.length}`)
	console.log(`mid ${mid} · spread ${SPREAD_BPS} bps · bid ${bid} · ask ${ask} · size ${ORDER_SIZE} ${POOL.baseCoin} · measured ${new Date().toISOString()}`)
	console.log('')
	console.log('| Shape | When it is submitted | status | computation (mist) | storage (mist) | rebate (mist) | net SUI | gross SUI | error |')
	console.log('|---|---|---|---|---|---|---|---|---|')
	for (const r of rows) {
		console.log(`| ${r.shape} | ${r.when} | ${r.status} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.netSui} | ${r.grossSui} | ${r.error || '—'} |`)
	}
	console.log('')
	console.log(`spread per full round trip at ${SPREAD_BPS} bps × ${ORDER_SIZE} ${POOL.baseCoin}: ${((ask - bid) * ORDER_SIZE).toFixed(9)} ${POOL.quoteCoin}`)
}

main().catch((err) => {
	console.error(String(err))
	process.exit(1)
})

/**
 * build-dryrun — measure what one maker transaction costs, without signing anything.
 *
 * Builds the same two transactions the agent builds, sets a sender, and asks the
 * RPC to simulate them. `dryRunTransactionBlock` takes unsigned bytes: no key, no
 * signature, no submission. Nothing here reaches waap-cli.
 *
 *   SIM_SENDER=0x… DEEPBOOK_BALANCE_MANAGER_ID=0x… npm run measure
 *
 * SIM_SENDER must hold SUI (it pays the simulated gas) and, for the requote row,
 * own or be able to reach the BalanceManager.
 */
import 'dotenv/config'

import { DeepBookClient, mainnetPools, testnetPools } from '@mysten/deepbook-v3'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { Transaction } from '@mysten/sui/transactions'

const NETWORK = (process.env.NETWORK ?? 'mainnet') as 'mainnet' | 'testnet'
const DEFAULT_RPC: Record<string, string> = {
	mainnet: 'https://sui-rpc.publicnode.com',
	testnet: getJsonRpcFullnodeUrl('testnet'),
}
const SUI_RPC = process.env.SUI_RPC ?? DEFAULT_RPC[NETWORK] ?? DEFAULT_RPC.mainnet

const POOL_KEY = process.env.POOL_KEY ?? 'DEEP_SUI'
const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? '20')
const ORDER_SIZE = Number(process.env.ORDER_SIZE ?? '10')
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
	label: string
	status: string
	computationCost: string
	storageCost: string
	storageRebate: string
	netSui: string
	error: string
}

async function simulate(label: string, build: (tx: Transaction) => void): Promise<Row> {
	const row: Row = {
		label,
		status: '—',
		computationCost: '—',
		storageCost: '—',
		storageRebate: '—',
		netSui: '—',
		error: '',
	}
	try {
		const tx = new Transaction()
		tx.setSender(SIM_SENDER!)
		build(tx)
		const bytes = await tx.build({ client: sui })
		const res = await sui.dryRunTransactionBlock({ transactionBlock: bytes })
		const gas = res.effects.gasUsed
		const computation = BigInt(gas.computationCost)
		const storage = BigInt(gas.storageCost)
		const rebate = BigInt(gas.storageRebate)
		const net = computation + storage - rebate
		row.status = res.effects.status.status
		row.computationCost = computation.toString()
		row.storageCost = storage.toString()
		row.storageRebate = rebate.toString()
		row.netSui = (Number(net) / MIST).toFixed(9)
		if (res.effects.status.error) row.error = res.effects.status.error
	} catch (err) {
		row.status = 'build_or_rpc_error'
		row.error = String(err).slice(0, 300).replace(/\|/g, '\\|').replace(/\n/g, ' ')
	}
	return row
}

async function main() {
	const l2 = await db.getLevel2TicksFromMid(POOL_KEY, 5)
	const mid = (l2.bid_prices[0] + l2.ask_prices[0]) / 2
	const half = SPREAD_BPS / 2 / 10_000
	const bookParams = await db.poolBookParams(POOL_KEY)
	const tick = bookParams.tickSize
	const bid = Number((Math.floor((mid * (1 - half)) / tick) * tick).toFixed(8))
	const ask = Number((Math.ceil((mid * (1 + half)) / tick) * tick).toFixed(8))

	const rows: Row[] = []

	rows.push(
		await simulate('(a) create BalanceManager', (tx) => {
			tx.add(db.balanceManager.createAndShareBalanceManager())
		}),
	)

	rows.push(
		await simulate('(b) requote: place bid + ask + withdrawSettledAmounts', (tx) => {
			if (!BALANCE_MANAGER_ID) throw new Error('DEEPBOOK_BALANCE_MANAGER_ID is required for row (b)')
			tx.add(
				db.deepBook.placeLimitOrder({
					poolKey: POOL_KEY,
					balanceManagerKey: MANAGER_KEY,
					clientOrderId: '1',
					price: bid,
					quantity: ORDER_SIZE,
					isBid: true,
				}),
			)
			tx.add(
				db.deepBook.placeLimitOrder({
					poolKey: POOL_KEY,
					balanceManagerKey: MANAGER_KEY,
					clientOrderId: '2',
					price: ask,
					quantity: ORDER_SIZE,
					isBid: false,
				}),
			)
			tx.add(db.deepBook.withdrawSettledAmounts(POOL_KEY, MANAGER_KEY))
		}),
	)

	console.log(`network: ${NETWORK} · rpc: ${SUI_RPC} · pool: ${POOL_KEY} (${POOL.address})`)
	console.log(`sender: ${SIM_SENDER} · balanceManager: ${BALANCE_MANAGER_ID ?? '(none)'}`)
	console.log(
		`mid: ${mid} · spread: ${SPREAD_BPS} bps · bid ${bid} · ask ${ask} · size ${ORDER_SIZE} ${POOL.baseCoin}`,
	)
	console.log('')
	console.log('| Transaction | status | computationCost (mist) | storageCost (mist) | storageRebate (mist) | net SUI | error |')
	console.log('|---|---|---|---|---|---|---|')
	for (const r of rows) {
		console.log(
			`| ${r.label} | ${r.status} | ${r.computationCost} | ${r.storageCost} | ${r.storageRebate} | ${r.netSui} | ${r.error || '—'} |`,
		)
	}

	// Spread earned per full round trip, at the configured spread and size.
	const spreadPerRoundTrip = (ask - bid) * ORDER_SIZE
	console.log('')
	console.log(
		`spread per full round trip (buy at bid, sell at ask, ${ORDER_SIZE} ${POOL.baseCoin}): ${spreadPerRoundTrip.toFixed(9)} ${POOL.quoteCoin}`,
	)
	const requote = rows[1]
	if (requote.netSui !== '—') {
		const ratio = spreadPerRoundTrip / Number(requote.netSui)
		console.log(`spread ÷ gas per requote: ${ratio.toFixed(2)}x`)
	}
}

main().catch((err) => {
	console.error(String(err))
	process.exit(1)
})

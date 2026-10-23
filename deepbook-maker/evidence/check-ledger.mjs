// Re-derive the 28 September ledger from public chain data. Read-only, no credentials, no dependencies.
//
//   node evidence/check-ledger.mjs                 # uses SUI_GRAPHQL or Mysten's public GraphQL
//
// It lists every transaction that touched the sender wallet in the manifest's window, checks
// the set matches the manifest, sums gas and wallet balance changes from each transaction's
// effects, reads the two OrderFilled events, and compares the totals with the manifest's
// `expected` block. Exit code 0 means all match.
//
// Sui GraphQL, not JSON-RPC: Mysten retired public JSON-RPC, publicnode has pruned these
// effects, and rpc-mainnet.suiscan.xyz returns 404 (all checked 2026-10-22).
import { readFileSync } from 'node:fs'

const m = JSON.parse(readFileSync(process.argv[2] ?? new URL('./2026-09-28-run-2.json', import.meta.url), 'utf8'))
const GQL = process.env.SUI_GRAPHQL || 'https://graphql.mainnet.sui.io/graphql'
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
const start = Date.parse(m.window.fromUtc)
const end = Date.parse(m.window.toUtc)

async function gql(query, variables) {
	for (let i = 0; ; i++) {
		try {
			const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
			const j = await r.json()
			if (j.errors) throw new Error(JSON.stringify(j.errors))
			return j.data
		} catch (err) {
			if (i === 3) throw err
			await new Promise((r) => setTimeout(r, 1000))
		}
	}
}

const TX_FIELDS = `digest sender { address }
	effects { status timestamp
		gasEffects { gasSummary { computationCost storageCost storageRebate } }
		balanceChanges(first: 50) { nodes { owner { address } amount coinType { repr } } }
		events(first: 50) { nodes { contents { type { repr } json } } } }`

// Every transaction that touched the sender, newest first, paged back until before the window.
const txs = new Map()
let before = null
for (;;) {
	const d = await gql(`query($a: SuiAddress!, $b: String) { transactions(last: 50, before: $b, filter: { affectedAddress: $a }) {
		pageInfo { hasPreviousPage startCursor } nodes { ${TX_FIELDS} } } }`, { a: m.sender, b: before })
	const page = d.transactions
	let oldest = Infinity
	for (const t of page.nodes) {
		const ts = Date.parse(t.effects.timestamp)
		oldest = Math.min(oldest, ts)
		if (ts >= start && ts <= end) txs.set(t.digest, t)
	}
	if (!page.pageInfo.hasPreviousPage || oldest < start) break
	before = page.pageInfo.startCursor
}

const fails = []
const expectDigests = new Set(m.transactions.map((t) => t.digest))
for (const d of txs.keys()) if (!expectDigests.has(d)) fails.push(`chain has a wallet transaction not in the manifest: ${d}`)
for (const d of expectDigests) if (!txs.has(d)) fails.push(`manifest transaction not found in the window: ${d}`)

const sum = { run_2: { gas: 0n, sui: 0n }, stopped_attempt: { gas: 0n, sui: 0n } }
let deep = 0n
for (const e of m.transactions) {
	const t = txs.get(e.digest)
	if (!t) continue
	if (t.effects.status !== 'SUCCESS') fails.push(`${e.digest} status ${t.effects.status}`)
	const g = t.effects.gasEffects.gasSummary
	const gas = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate)
	const mine = t.effects.balanceChanges.nodes.filter((b) => b.owner?.address === m.sender)
	const sui = mine.filter((b) => b.coinType.repr === SUI).reduce((s, b) => s + BigInt(b.amount), 0n)
	deep += mine.filter((b) => b.coinType.repr.endsWith('::deep::DEEP')).reduce((s, b) => s + BigInt(b.amount), 0n)
	if (gas !== BigInt(e.netGasMist)) fails.push(`${e.digest} gas ${gas} ≠ manifest ${e.netGasMist}`)
	if (sui !== BigInt(e.walletSuiMist)) fails.push(`${e.digest} wallet SUI ${sui} ≠ manifest ${e.walletSuiMist}`)
	sum[e.attempt].gas += gas
	sum[e.attempt].sui += sui
}

let spreadMist = 0n
for (const f of m.fills) {
	const t = (await gql(`query($d: String!) { transaction(digest: $d) { ${TX_FIELDS} } }`, { d: f.digest })).transaction
	const ev = t.effects.events.nodes.map((x) => ({ type: x.contents.type.repr, j: x.contents.json }))
		.find((x) => x.type.endsWith('::order_info::OrderFilled') && x.j.maker_balance_manager_id === m.balanceManager)
	if (!ev) { fails.push(`${f.digest}: no OrderFilled with our manager as maker`); continue }
	const ourBid = ev.j.taker_is_bid === false
	if ((ourBid ? 'bid' : 'ask') !== f.ourSide) fails.push(`${f.digest}: side`)
	if (t.sender.address === m.sender) fails.push(`${f.digest}: the taker is our own sender`)
	spreadMist += (ourBid ? -1n : 1n) * BigInt(ev.j.quote_quantity)
}

const sui = (x) => (Number(x) / 1e9).toFixed(9)
const got = {
	'run_2 spread': [sui(spreadMist), m.expected.run_2.spreadSui],
	'run_2 net gas': [sui(sum.run_2.gas), m.expected.run_2.netGasSui],
	'run_2 result': [sui(spreadMist - sum.run_2.gas), m.expected.run_2.resultSui],
	'stopped attempt net gas': [sui(sum.stopped_attempt.gas), m.expected.stopped_attempt.netGasSui],
	'window wallet SUI change': [sui(sum.run_2.sui + sum.stopped_attempt.sui), m.expected.window.walletSuiChange],
	'window wallet DEEP change': [String(deep), m.expected.window.walletDeepChange],
}
for (const [k, [a, b]] of Object.entries(got)) {
	console.log(`${a === b ? 'ok  ' : 'FAIL'} ${k}: ${a} (manifest ${b})`)
	if (a !== b) fails.push(k)
}
console.log(`${txs.size} wallet transactions in the window; ${m.fills.length} fills read; source ${GQL}`)
for (const f of fails) console.log(`FAIL ${f}`)
process.exit(fails.length ? 1 : 0)

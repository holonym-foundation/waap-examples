// Re-derive the 28 September ledger from public chain data. Read-only, no credentials, no dependencies.
//
//   node evidence/check-ledger.mjs                 # uses SUI_RPC or publicnode
//
// It lists every transaction that changed the sender wallet in the manifest's window
// (FromAddress and ToAddress queries), checks the set matches the manifest, sums gas and
// wallet balance changes from each transaction's effects, reads the two OrderFilled events,
// and compares the totals with the manifest's `expected` block. Exit code 0 means all match.
import { readFileSync } from 'node:fs'

const m = JSON.parse(readFileSync(new URL('./2026-09-28-run-2.json', import.meta.url), 'utf8'))
const RPC = process.env.SUI_RPC || 'https://sui-rpc.publicnode.com'
const SUI = '0x2::sui::SUI'
const start = Date.parse(m.window.fromUtc)
const end = Date.parse(m.window.toUtc)

let id = 0
async function rpc(method, params) {
	for (let i = 0; ; i++) {
		try {
			const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
			const j = await r.json()
			if (j.error) throw new Error(JSON.stringify(j.error))
			return j.result
		} catch (err) {
			if (i === 3) throw err
			await new Promise((r) => setTimeout(r, 1000))
		}
	}
}

async function inWindow(filter) {
	const out = []
	let cursor = null
	for (;;) {
		const page = await rpc('suix_queryTransactionBlocks', [{ filter, options: { showEffects: true, showBalanceChanges: true } }, cursor, 50, true])
		for (const t of page.data) if (Number(t.timestampMs) >= start && Number(t.timestampMs) <= end) out.push(t)
		const last = page.data.at(-1)
		if (!page.hasNextPage || !last || Number(last.timestampMs) < start) return out
		cursor = page.nextCursor
	}
}

const txs = new Map()
for (const t of [...(await inWindow({ FromAddress: m.sender })), ...(await inWindow({ ToAddress: m.sender }))]) txs.set(t.digest, t)

const fails = []
const expectDigests = new Set(m.transactions.map((t) => t.digest))
for (const d of txs.keys()) if (!expectDigests.has(d)) fails.push(`chain has a wallet transaction not in the manifest: ${d}`)
for (const d of expectDigests) if (!txs.has(d)) fails.push(`manifest transaction not found in the window: ${d}`)

const sum = { run_2: { gas: 0n, sui: 0n }, stopped_attempt: { gas: 0n, sui: 0n } }
let deep = 0n
for (const e of m.transactions) {
	const t = txs.get(e.digest)
	if (!t) continue
	if (t.effects.status.status !== 'success') fails.push(`${e.digest} status ${t.effects.status.status}`)
	const g = t.effects.gasUsed
	const gas = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate)
	const mine = (t.balanceChanges ?? []).filter((b) => b.owner?.AddressOwner === m.sender)
	const sui = mine.filter((b) => b.coinType === SUI).reduce((s, b) => s + BigInt(b.amount), 0n)
	deep += mine.filter((b) => b.coinType.endsWith('::deep::DEEP')).reduce((s, b) => s + BigInt(b.amount), 0n)
	if (gas !== BigInt(e.netGasMist)) fails.push(`${e.digest} gas ${gas} ≠ manifest ${e.netGasMist}`)
	if (sui !== BigInt(e.walletSuiMist)) fails.push(`${e.digest} wallet SUI ${sui} ≠ manifest ${e.walletSuiMist}`)
	sum[e.attempt].gas += gas
	sum[e.attempt].sui += sui
}

let spreadMist = 0n
for (const f of m.fills) {
	const t = await rpc('sui_getTransactionBlock', [f.digest, { showEvents: true, showInput: true }])
	const ev = t.events.map((x) => ({ type: x.type, j: x.parsedJson })).find((x) => x.type.endsWith('::order_info::OrderFilled') && x.j.maker_balance_manager_id === m.balanceManager)
	if (!ev) { fails.push(`${f.digest}: no OrderFilled with our manager as maker`); continue }
	const ourBid = ev.j.taker_is_bid === false
	if ((ourBid ? 'bid' : 'ask') !== f.ourSide) fails.push(`${f.digest}: side`)
	if (t.transaction.data.sender === m.sender) fails.push(`${f.digest}: the taker is our own sender`)
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
console.log(`${txs.size} wallet transactions in the window; ${m.fills.length} fills read`)
for (const f of fails) console.log(`FAIL ${f}`)
process.exit(fails.length ? 1 : 0)

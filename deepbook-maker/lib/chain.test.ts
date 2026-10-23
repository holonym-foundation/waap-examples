/**
 * The GraphQL/indexer read path, against transactions whose numbers are already proven.
 *
 * `fixtures/graphql-txs-2026-10-22.json` is the raw Sui GraphQL answer for the four
 * transactions of the 22 October live run (create, deposit, requote, cleanup), the
 * 28 September run-2 fill and two September fills from the JSON-RPC fixtures. The gas
 * figures below are the ones the on-chain ledger check reconciled to the mist, so if the
 * adapter mis-maps a field these tests say which.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cursorAtTime, getTransaction, indexerFillQuery, toChainTx, type PostJson } from './chain.ts'
import { findCreatedBalanceManagerId, parseOrderFilled, parseOrderPlaced, type ParseOptions } from './events.ts'
import { collectFillsFromPage } from './fills.ts'
import { parseGasUsed } from './receipts.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const RAW = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'graphql-txs-2026-10-22.json'), 'utf8')) as Record<string, Parameters<typeof toChainTx>[0]>
const tx = (prefix: string) => toChainTx(RAW[Object.keys(RAW).find((k) => k.startsWith(prefix))!])

const DEEP_SUI = '0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22'
const OPTS: ParseOptions = { floatScalar: 1e9, baseScalar: 1e6, quoteScalar: 1e9, poolId: DEEP_SUI }

test('22 Oct receipts: net gas matches the chain-reconciled ledger to the mist', () => {
	const expected: Record<string, number> = { '974eoNoH': 0.0020834, HdDwZMNV: 0.002628459, '3eaGdxdb': 0.005414306, D4kPQ5h3: -0.005319866 }
	let total = 0
	for (const [d, net] of Object.entries(expected)) {
		const g = parseGasUsed(tx(d))
		assert.ok(g, d)
		assert.equal(g.status, 'success', d)
		assert.equal(Math.round(g.netSui * 1e9), Math.round(net * 1e9), d)
		total += g.netSui
	}
	assert.equal(Math.round(total * 1e9), 4_806_299, 'the run total in ledger-check.txt')
})

test('the create transaction yields the BalanceManager the run saved', () => {
	assert.equal(findCreatedBalanceManagerId(tx('974eoNoH')), '0xc41d1ed8f77ae4a6cacc0917b5d6aa666303d96b1603724af85d581e555228ac')
})

test('the requote yields the two orders the run confirmed', () => {
	const placed = parseOrderPlaced(tx('3eaGdxdb'), { ...OPTS, balanceManagerId: '0xc41d1ed8f77ae4a6cacc0917b5d6aa666303d96b1603724af85d581e555228ac' })
	assert.deepEqual(
		placed.map((o) => [o.isBid ? 'bid' : 'ask', o.price, o.quantity]),
		[['bid', 0.01844, 100], ['ask', 0.01855, 100]],
	)
})

test('the 28 Sep fill parses as our bid of 50 DEEP for 0.9365 SUI, as in the manifest', () => {
	const [f] = parseOrderFilled(tx('397dDA4Y'), { ...OPTS, balanceManagerId: '0xdceb4ba0957e681550518f87b62c12a5bed5d420f1cfadf156cb08be9f2dd2b5' })
	assert.equal(f.role, 'maker')
	assert.equal(f.isBid, true)
	assert.equal(f.quantity, 50)
	assert.equal(f.quoteQuantity, 0.9365)
})

test('event ids match the JSON-RPC ones, so fill keys saved by older runs still dedupe', () => {
	// fixtures/events-orderfilled-page-2026-09-15.json: the same fill, as JSON-RPC returned it.
	const old = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'events-orderfilled-page-2026-09-15.json'), 'utf8')).data[0]
	const fills = collectFillsFromPage(tx('7Tt99TuU').events, { ...OPTS, balanceManagerId: old.parsedJson.maker_balance_manager_id })
	assert.ok(fills.some((f) => f.key === `${old.id.txDigest}:${old.id.eventSeq}`))
})

test('a transaction GraphQL has not indexed yet throws, so the callers retry', async () => {
	const post: PostJson = async () => ({ data: { transaction: null } })
	await assert.rejects(getTransaction(post, 'http://x', 'NEW'), /not found yet/)
})

test('the fill finder asks the indexer from the cursor time and returns chain events with their time', async () => {
	const urls: string[] = []
	const q = indexerFillQuery({
		get: async (url) => {
			urls.push(url)
			return [{ digest: '397dDA4YyN56gNtUiPRwbN7GiHyKAagiPQSiYWpEwq4U', timestamp: 1790693714790 }]
		},
		post: async (_url, body) => ({ data: { transaction: RAW[(body as { variables: { d: string } }).variables.d] } }),
		indexerUrl: 'https://indexer.test/',
		graphqlUrl: 'https://graphql.test',
		poolKey: 'DEEP_SUI',
		managerId: '0xdceb',
		now: () => 1790693800000,
	})
	const page = await q({ eventType: 'x', cursor: cursorAtTime(1790693700000), limit: 50, descending: false })
	assert.match(urls[0], /^https:\/\/indexer\.test\/trades\/DEEP_SUI\?balance_manager_id=0xdceb&start_time=1790693700&end_time=1790693801&limit=1000$/)
	assert.equal(page.hasNextPage, false)
	assert.ok(page.data.some((e) => e.type.endsWith('::order_info::OrderFilled')))
	assert.equal(page.nextCursor?.txDigest, '397dDA4YyN56gNtUiPRwbN7GiHyKAagiPQSiYWpEwq4U')
	assert.ok((page.nextCursor as { timestampMs?: string }).timestampMs, 'the cursor carries the fill time')
})

test('no new trades: the cursor stays where it was', async () => {
	const start = cursorAtTime(1_000_000)
	const q = indexerFillQuery({ get: async () => [], post: async () => ({}), indexerUrl: 'u', graphqlUrl: 'g', poolKey: 'DEEP_SUI', managerId: 'm', now: () => 2_000_000 })
	const page = await q({ eventType: 'x', cursor: start, limit: 50, descending: false })
	assert.deepEqual(page, { data: [], nextCursor: start, hasNextPage: false })
})

test('a full indexer page (newest first) is walked back until nothing older is missed', async () => {
	// 1,500 trades, one per second; the indexer returns the newest 1,000 of a window, newest first.
	const all = Array.from({ length: 1500 }, (_, i) => ({ digest: `D${i}`, timestamp: 1_000_000_000 + i * 1000 }))
	const asked: string[] = []
	const q = indexerFillQuery({
		get: async (url) => {
			asked.push(url)
			const u = new URL(url)
			const from = Number(u.searchParams.get('start_time')) * 1000
			const to = Number(u.searchParams.get('end_time')) * 1000
			return all.filter((t) => t.timestamp >= from && t.timestamp <= to).sort((a, b) => b.timestamp - a.timestamp).slice(0, 1000)
		},
		post: async (_u, body) => {
			const d = (body as { variables: { d: string } }).variables.d
			const t = all.find((x) => x.digest === d)!
			return { data: { transaction: { digest: d, effects: { status: 'SUCCESS', timestamp: new Date(t.timestamp).toISOString(), events: { nodes: [{ sequenceNumber: 0, contents: { type: { repr: '0x2::x::OrderFilled' }, json: {} } }] } } } } }
		},
		indexerUrl: 'https://i',
		graphqlUrl: 'https://g',
		poolKey: 'DEEP_SUI',
		managerId: 'm',
		now: () => 1_000_000_000 + 1500 * 1000,
	})
	const page = await q({ eventType: 'x', cursor: cursorAtTime(1_000_000_000), limit: 50, descending: false })
	assert.equal(asked.length, 2, 'a second, older page was requested')
	assert.equal(new Set(page.data.map((e) => e.id?.txDigest)).size, 1500, 'every trade since the cursor is returned once')
	assert.equal(page.data[0].id?.txDigest, 'D0', 'oldest first')
	assert.equal(page.hasNextPage, false)
})

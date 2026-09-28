import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	DEFAULT_FILL_SCAN_PAGES,
	MEASURED_FILL_EVENTS_PER_HOUR,
	collectFillsFromPage,
	cursorOf,
	FillLedger,
	fillKey,
	ORDER_FILLED_TYPE,
	walkFills,
	type EventPage,
	type QueriedEvent,
	type QueryEvents,
} from './fills.ts'
import type { ParseOptions } from './events.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * A REAL page of `suix_queryEvents`, fetched from mainnet on 2026-09-24 and saved
 * verbatim. It is the page containing the fill this recipe's own logs could not see:
 * maker order `384983548836765086299601320011`, placed by this agent at tick 4 of the
 * 2026-09-15 five-tick run, crossed by a taker at 12:02:48Z in digest
 * `7Tt99TuU5xuFGkAzRhjSAbFZHv2LPsGL1FyLNTmrB5NX` — a transaction the agent never
 * submitted, never fetched and has no record of.
 */
const PAGE = JSON.parse(
	fs.readFileSync(path.join(FIXTURES, 'events-orderfilled-page-2026-09-15.json'), 'utf8'),
) as EventPage

/** DEEP/SUI mainnet. floatScalar 1e9, DEEP 1e6, SUI 1e9. */
const POOL = '0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22'
const OUR_MANAGER = '0xdceb4ba0957e681550518f87b62c12a5bed5d420f1cfadf156cb08be9f2dd2b5'
const OPTS: ParseOptions = { floatScalar: 1e9, baseScalar: 1e6, quoteScalar: 1e9, poolId: POOL, balanceManagerId: OUR_MANAGER }

const EXTERNAL_FILL_DIGEST = '7Tt99TuU5xuFGkAzRhjSAbFZHv2LPsGL1FyLNTmrB5NX'
const OUR_ORDER_ID = '384983548836765086299601320011'

// --- reconciliation against the known externally caused fill ------------------

test('the externally caused maker fill is found in the event stream', () => {
	const fills = collectFillsFromPage(PAGE.data, OPTS)
	assert.equal(fills.length, 1, 'exactly one fill on this page belongs to our manager')
	const f = fills[0]
	assert.equal(f.makerOrderId, OUR_ORDER_ID)
	assert.equal(f.txDigest, EXTERNAL_FILL_DIGEST)
	assert.equal(f.key, fillKey(EXTERNAL_FILL_DIGEST, f.eventSeq))
	// taker_is_bid was false, so the maker was the bid: we bought.
	assert.equal(f.isBid, true)
	assert.equal(f.quantity, 20)
	assert.equal(f.price, 0.02087)
	assert.equal(f.quoteQuantity, 0.4174)
})

test('the fill is in a transaction this agent never submitted', () => {
	// The five-tick run's own submissions, from logs/live-5tick.jsonl. If the fill's
	// digest were among them, `reconcileFromChain` would have caught it and this whole
	// collection path would be unnecessary. It is not among them.
	const ourDigests = [
		'2dVbjYjZTdtKcE9thvXcPuyJ2ox7WjzJg84QWqrtn1NK',
		'BeNimWVeLcEbM1sX6WagNJKcC8LT5scBnNt9JTwafZCV',
		'4xzjmW7caT5JCwL1nGc591ev88EkMXWt4fqL68vwFtoH',
		'4gmjUNbasWvuGVCTA18wbAwLbvAQmGWYxCth8uJVFFwD',
		'6qXJUyPxrePAbtfFD2EufHDisYdu4wpy5oEq1t5yD7H8',
	]
	assert.ok(!ourDigests.includes(EXTERNAL_FILL_DIGEST))
})

test('another manager on the same pool is not our fill', () => {
	const other = collectFillsFromPage(PAGE.data, { ...OPTS, balanceManagerId: '0xdeadbeef' })
	assert.equal(other.length, 0)
})

test('the same fill on another pool is filtered out', () => {
	const wrongPool = collectFillsFromPage(PAGE.data, { ...OPTS, poolId: '0xnotourpool' })
	assert.equal(wrongPool.length, 0)
})

// --- dedup -------------------------------------------------------------------

test('a page re-read after a failure logs nothing twice', () => {
	const ledger = new FillLedger()
	const first = ledger.add(collectFillsFromPage(PAGE.data, OPTS))
	const second = ledger.add(collectFillsFromPage(PAGE.data, OPTS))
	assert.equal(first.length, 1)
	assert.equal(second.length, 0, 'the second read of the same page is entirely new-free')
	assert.equal(ledger.size, 1)
})

test('a ledger seeded from a previous run does not re-emit', () => {
	const fills = collectFillsFromPage(PAGE.data, OPTS)
	const ledger = new FillLedger(fills)
	assert.equal(ledger.add(fills).length, 0)
	assert.ok(ledger.has(fills[0].key))
})

// --- the walk ----------------------------------------------------------------

function fakeEvent(digest: string, seq: string, timestampMs: number, managerId = OUR_MANAGER): QueriedEvent {
	return {
		id: { txDigest: digest, eventSeq: seq },
		type: ORDER_FILLED_TYPE,
		timestampMs: String(timestampMs),
		parsedJson: {
			maker_order_id: `order-${digest}-${seq}`,
			maker_balance_manager_id: managerId,
			taker_balance_manager_id: '0xtaker',
			pool_id: POOL,
			price: '20870000000',
			base_quantity: '20000000',
			quote_quantity: '417400000',
			taker_is_bid: false,
			timestamp: String(timestampMs),
		},
	}
}

/** A fake fullnode: pages handed out in order, cursor echoed back. */
function fakeQuery(pages: QueriedEvent[][]): { query: QueryEvents; calls: number[] } {
	const calls: number[] = []
	let i = 0
	const query: QueryEvents = async ({ limit }) => {
		calls.push(limit)
		const data = pages[i] ?? []
		const hasNextPage = i < pages.length - 1
		const last = data.at(-1)
		i++
		return { data, nextCursor: last ? cursorOf(last) : null, hasNextPage }
	}
	return { query, calls }
}

test('the walk pages to the head and returns the last cursor', async () => {
	const { query } = fakeQuery([
		[fakeEvent('d1', '0', 1000), fakeEvent('d2', '1', 2000)],
		[fakeEvent('d3', '0', 3000)],
	])
	const res = await walkFills({ query, cursor: null, opts: OPTS })
	assert.equal(res.fills.length, 3)
	assert.equal(res.pages, 2)
	assert.equal(res.scanned, 3)
	assert.equal(res.truncated, false)
	assert.deepEqual(res.cursor, { txDigest: 'd3', eventSeq: '0' })
})

test('the walk stops at maxPages and reports truncated, keeping the resume cursor', async () => {
	const { query } = fakeQuery([[fakeEvent('d1', '0', 1000)], [fakeEvent('d2', '0', 2000)], [fakeEvent('d3', '0', 3000)]])
	const res = await walkFills({ query, cursor: null, opts: OPTS, maxPages: 2 })
	assert.equal(res.pages, 2)
	assert.equal(res.truncated, true, 'a truncated walk has NOT caught up')
	assert.deepEqual(res.cursor, { txDigest: 'd2', eventSeq: '0' }, 'the next call resumes where this one stopped')
	assert.equal(res.fills.length, 2)
})

test('the walk stops at endTimeMs and never advances past the boundary', async () => {
	const { query } = fakeQuery([[fakeEvent('d1', '0', 1000), fakeEvent('d2', '0', 2000), fakeEvent('d3', '0', 9999)]])
	const res = await walkFills({ query, cursor: null, opts: OPTS, endTimeMs: 5000 })
	assert.equal(res.reachedEnd, true)
	assert.equal(res.fills.length, 2, 'the event after the window is not collected')
	assert.deepEqual(res.cursor, { txDigest: 'd2', eventSeq: '0' }, 'the cursor stays on the last event inside the window')
})

test('a resumed walk continues rather than repeating', async () => {
	const ledger = new FillLedger()
	const first = fakeQuery([[fakeEvent('d1', '0', 1000)]])
	const a = await walkFills({ query: first.query, cursor: null, opts: OPTS, ledger })
	const second = fakeQuery([[fakeEvent('d1', '0', 1000), fakeEvent('d2', '0', 2000)]])
	const b = await walkFills({ query: second.query, cursor: a.cursor, opts: OPTS, ledger })
	assert.equal(a.fills.length, 1)
	assert.equal(b.fills.length, 1, 'the overlapping event is deduped, only the new one is emitted')
	assert.equal(ledger.size, 2)
})

test('events from other managers are scanned but not collected', async () => {
	const { query } = fakeQuery([[fakeEvent('d1', '0', 1000, '0xsomeone-else'), fakeEvent('d2', '0', 2000)]])
	const res = await walkFills({ query, cursor: null, opts: OPTS })
	assert.equal(res.scanned, 2)
	assert.equal(res.fills.length, 1)
})

test('all() returns fills in timestamp order whatever order they arrived', () => {
	const ledger = new FillLedger()
	ledger.add(collectFillsFromPage([fakeEvent('d2', '0', 5000), fakeEvent('d1', '0', 1000)], OPTS))
	assert.deepEqual(
		ledger.all().map((f) => f.txDigest),
		['d1', 'd2'],
	)
})

// --- completion reason (28 Sep plan review, reproduced boundary) ---------------

test('end of stream on exactly the last allowed page is `head`, not truncated', async () => {
	// The old walk returned `truncated: true, reachedEnd: false` here: a caller gating on
	// it would wait forever for a backfill that had finished.
	const r = await walkFills({ query: async () => ({ data: [], hasNextPage: false, nextCursor: null }), cursor: null, opts: OPTS, maxPages: 1 })
	assert.equal(r.completion, 'head')
	assert.equal(r.truncated, false)
	assert.equal(r.reachedEnd, false)
})

test('a walk that runs out of pages with more to read is `page_budget`, and resumes from its cursor', async () => {
	let n = 0
	const query: QueryEvents = async () => {
		n++
		return { data: [{ type: 'x', id: { txDigest: `D${n}`, eventSeq: '0' }, timestampMs: String(1000 + n) }], hasNextPage: true, nextCursor: { txDigest: `D${n}`, eventSeq: '0' } }
	}
	const r = await walkFills({ query, cursor: null, opts: OPTS, maxPages: 2 })
	assert.equal(r.completion, 'page_budget')
	assert.equal(r.truncated, true)
	assert.deepEqual(r.cursor, { txDigest: 'D2', eventSeq: '0' })
	assert.equal(r.watermarkMs, 1002)
})

test('the exact boundary: last page has hasNextPage false on the final allowed read → head', async () => {
	let n = 0
	const query: QueryEvents = async () => {
		n++
		return { data: [], hasNextPage: n < 3, nextCursor: { txDigest: `D${n}`, eventSeq: '0' } }
	}
	const r = await walkFills({ query, cursor: null, opts: OPTS, maxPages: 3 })
	assert.equal(r.pages, 3)
	assert.equal(r.completion, 'head')
})

test('the default page budget covers a burst tick with room to spare and backfills ~50 min of history per tick', () => {
	const perPage = 50
	// Steady state: a slow 90 s tick at the measured peak burst (~11,000/h).
	assert.ok(Math.ceil((11_000 / 3600) * 90 / perPage) * 4 <= DEFAULT_FILL_SCAN_PAGES)
	// Backfill: history covered per tick at the measured average rate, in minutes.
	const minutesPerTick = (DEFAULT_FILL_SCAN_PAGES * perPage) / MEASURED_FILL_EVENTS_PER_HOUR * 60
	assert.ok(minutesPerTick >= 45, `${minutesPerTick}`)
})

import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeOrderId, distanceBps, ownOrderLock, planQuotes, reconcileResting, roundToTick, type PlanQuotesInput } from './quotes.ts'

// DEEP/SUI mainnet book parameters, read from `poolBookParams('DEEP_SUI')` on 2026-09-13:
// tick 0.00001, lot 1 DEEP, min 10 DEEP.
const TICK = 0.00001
const LOT = 1
const MIN_SIZE = 10

// A mid taken from a live read of the DEEP/SUI book.
const MID = 0.02136

// spreadBps is the full spread, so each side sits 10 bps off mid.
const BID_TARGET = roundToTick(MID * (1 - 0.001), TICK, 'down') // 0.02133
const ASK_TARGET = roundToTick(MID * (1 + 0.001), TICK, 'up') //   0.02139

// What one bid costs in SUI: 10 DEEP × 0.02133 ≈ 0.2133 SUI.
const BID_NOTIONAL = 10 * BID_TARGET

function base(overrides: Partial<PlanQuotesInput> = {}): PlanQuotesInput {
	return {
		mid: MID,
		spreadBps: 20,
		orderSize: 10,
		baseInventory: 1_000,
		quoteInventory: 1_000,
		baseFloor: 0,
		quoteFloor: 0,
		resting: [],
		requoteToleranceBps: 5,
		tickSize: TICK,
		lotSize: LOT,
		minSize: MIN_SIZE,
		...overrides,
	}
}

test('both sides quoted when inventory clears both floors', () => {
	const plan = planQuotes(base())

	assert.deepEqual(plan.skippedSides, [])
	assert.deepEqual(plan.cancels, [])
	assert.equal(plan.place.length, 2)

	const bid = plan.place.find((o) => o.isBid)!
	const ask = plan.place.find((o) => !o.isBid)!
	assert.equal(bid.price, BID_TARGET)
	assert.equal(ask.price, ASK_TARGET)
	assert.equal(bid.quantity, 10)
	assert.equal(ask.quantity, 10)
	// Prices land on the tick grid and straddle mid.
	assert.equal(bid.price % TICK < 1e-9 || Math.abs((bid.price % TICK) - TICK) < 1e-9, true)
	assert.equal(bid.price < MID && ask.price > MID, true)
})

test('base below its floor means no ask', () => {
	// Enough DEEP to back the ask (105 ≥ 10) but not enough left over: 105 - 10 < 100.
	// So this isolates the floor rule from the size rule.
	const plan = planQuotes(base({ baseInventory: 105, baseFloor: 100 }))

	assert.deepEqual(plan.skippedSides, ['base_below_floor'])
	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, true)
	assert.equal(plan.place[0].price, BID_TARGET)
})

test('quote below its floor means no bid', () => {
	// Enough SUI to back the bid (100.1 ≥ ~0.2133) but not enough left over.
	const plan = planQuotes(base({ quoteInventory: 100.1, quoteFloor: 100 }))

	assert.deepEqual(plan.skippedSides, ['quote_below_floor'])
	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, false)
	assert.equal(plan.place[0].price, ASK_TARGET)
})

test('SUI-only bootstrap: no DEEP means bid only, reason base_below_size', () => {
	// The funded run starts here: the wallet holds SUI and no DEEP. There is nothing
	// to sell, so the agent must plan a bid and no ask — with floors still at 0.
	const plan = planQuotes(base({ baseInventory: 0, quoteInventory: 10, baseFloor: 0, quoteFloor: 0 }))

	assert.deepEqual(plan.skippedSides, ['base_below_size'])
	assert.deepEqual(plan.cancels, [])
	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, true)
	assert.equal(plan.place[0].price, BID_TARGET)
	assert.equal(plan.place[0].quantity, 10)
})

test('DEEP-only: no SUI means ask only, reason quote_below_size', () => {
	// The mirror case, and the one that catches a bid the manager cannot pay for:
	// 0.1 SUI will not cover a 10 DEEP bid at ~0.2133 SUI.
	assert.equal(BID_NOTIONAL > 0.1, true)
	const plan = planQuotes(base({ baseInventory: 1_000, quoteInventory: 0.1, baseFloor: 0, quoteFloor: 0 }))

	assert.deepEqual(plan.skippedSides, ['quote_below_size'])
	assert.deepEqual(plan.cancels, [])
	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, false)
	assert.equal(plan.place[0].price, ASK_TARGET)
	assert.equal(plan.place[0].quantity, 10)
})

test('resting orders within tolerance are kept, not requoted', () => {
	const plan = planQuotes(
		base({
			resting: [
				{ orderId: 'bid-1', isBid: true, price: BID_TARGET, quantity: 10 },
				// One tick off the ask target is ~4.7 bps — inside a 5 bps tolerance.
				{ orderId: 'ask-1', isBid: false, price: roundToTick(ASK_TARGET - TICK, TICK, 'down'), quantity: 10 },
			],
		}),
	)

	assert.deepEqual(plan.cancels, [])
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, [])
})

test('resting orders off target are cancelled and requoted', () => {
	const plan = planQuotes(
		base({
			resting: [
				{ orderId: 'bid-old', isBid: true, price: 0.02, quantity: 10 },
				{ orderId: 'ask-old', isBid: false, price: 0.023, quantity: 10 },
			],
		}),
	)

	assert.deepEqual(plan.cancels.sort(), ['ask-old', 'bid-old'])
	assert.equal(plan.place.length, 2)
	assert.equal(plan.place.find((o) => o.isBid)!.price, BID_TARGET)
	assert.equal(plan.place.find((o) => !o.isBid)!.price, ASK_TARGET)
	assert.deepEqual(plan.skippedSides, [])
})

// -----------------------------------------------------------------------------
// Inventory churn — the regression from ticks 2-4 of the first live run.
//
// Numbers are read straight out of logs/live-5tick.jsonl:
//   tick 2  mid 0.02089   → placed bid 20 DEEP @ 0.02086 (0.4172 SUI of a 0.45 deposit)
//   tick 3  mid 0.020895  → inventory {quote: 0.0328, locked.quote: 0.4172}
//                           planned skippedSides ["quote_below_size", …] and CANCELLED
//                           the bid, because only the available balance was counted
//   tick 4  mid 0.020895  → quote free again, bid re-placed. One wasted round trip,
//                           two wasted gas payments, zero change in the quote.
// -----------------------------------------------------------------------------

// The live run used ORDER_SIZE=20.
const LIVE_SIZE = 20
const TICK3_MID = 0.020895
const TICK3_RESTING_PRICE = 0.02086 // what tick 2 actually placed
const TICK3_AVAILABLE_QUOTE = 0.03 // free SUI once the bid locked the rest
const TICK3_LOCKED_QUOTE = 0.417 // SUI locked inside our own resting bid

function tick3(overrides: Partial<PlanQuotesInput> = {}): PlanQuotesInput {
	return base({
		mid: TICK3_MID,
		orderSize: LIVE_SIZE,
		baseInventory: 0,
		quoteInventory: TICK3_AVAILABLE_QUOTE,
		quoteLocked: TICK3_LOCKED_QUOTE,
		resting: [{ orderId: '384799081396027990783441320029', isBid: true, price: TICK3_RESTING_PRICE, quantity: LIVE_SIZE }],
		...overrides,
	})
}

test('tick 3: a resting bid inside tolerance survives its own locked funds', () => {
	const input = tick3()
	// The premise: the bid really is within tolerance of this tick's target...
	const bidTarget = roundToTick(TICK3_MID * (1 - 0.001), TICK, 'down') // 0.02087
	assert.equal(distanceBps(TICK3_RESTING_PRICE, bidTarget) <= 5, true)
	// ...and the available balance really is far below one bid's notional. Counting
	// available alone is what produced `quote_below_size` and the cancel.
	assert.equal(TICK3_AVAILABLE_QUOTE < LIVE_SIZE * bidTarget, true)

	const plan = planQuotes(input)

	assert.deepEqual(plan.cancels, [])
	assert.deepEqual(plan.place, [])
	// The bid side is quoted by the order already on the book. Only the ask is skipped,
	// and for the honest reason: the manager holds no DEEP.
	assert.deepEqual(plan.skippedSides, ['base_below_size'])
})

test('tick 3 without the locked balance is the bug, reproduced', () => {
	// Same tick, `quoteLocked` left at 0 — which is what `planQuotes` was effectively
	// given before the fix. Kept as an executable record of the defect: the resting bid
	// is still inside tolerance, so it must survive on the strength of step 3 alone.
	const plan = planQuotes(tick3({ quoteLocked: 0 }))

	assert.deepEqual(plan.cancels, [])
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['base_below_size'])
})

test('mid beyond tolerance: cancel and re-place in the same PTB, funded by the cancel', () => {
	// The mid has run away from the resting bid, so it must be requoted. Available quote
	// (0.03 SUI) cannot pay for the new bid on its own — the funds are inside the order
	// being cancelled, and a PTB unlocks them before the place that follows.
	const movedMid = 0.021
	const plan = planQuotes(tick3({ mid: movedMid }))
	const newTarget = roundToTick(movedMid * (1 - 0.001), TICK, 'down') // 0.02097

	assert.equal(distanceBps(TICK3_RESTING_PRICE, newTarget) > 5, true)
	assert.deepEqual(plan.cancels, ['384799081396027990783441320029'])
	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, true)
	assert.equal(plan.place[0].price, newTarget)
	assert.equal(plan.place[0].quantity, LIVE_SIZE)
	assert.deepEqual(plan.skippedSides, ['base_below_size'])

	// The place is short on available balance by less than what the cancel returns.
	const cost = LIVE_SIZE * newTarget
	assert.equal(TICK3_AVAILABLE_QUOTE < cost, true)
	assert.equal(TICK3_AVAILABLE_QUOTE + TICK3_LOCKED_QUOTE >= cost, true)
})

test('genuinely unfunded side is still skipped, and its stale order pulled', () => {
	// The guard on the rule above. Same requote, but nothing is locked — the manager
	// really is out of SUI. The stale bid is cancelled and no bid is planned.
	const plan = planQuotes(tick3({ mid: 0.021, quoteLocked: 0 }))

	assert.deepEqual(plan.cancels, ['384799081396027990783441320029'])
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['quote_below_size', 'base_below_size'])
})

test('duplicate orders on a kept side are cancelled, the in-tolerance one is not', () => {
	// Two bids resting, one on target and one stale. The side stays quoted by the good
	// one; only the stale id goes into `cancels`, and nothing new is placed.
	const plan = planQuotes(
		tick3({
			resting: [
				{ orderId: 'bid-stale', isBid: true, price: 0.0201, quantity: LIVE_SIZE },
				{ orderId: 'bid-good', isBid: true, price: TICK3_RESTING_PRICE, quantity: LIVE_SIZE },
			],
		}),
	)

	assert.deepEqual(plan.cancels, ['bid-stale'])
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['base_below_size'])
})

// -----------------------------------------------------------------------------
// `lockedBalance` is not "locked in resting orders".
//
// Measured on mainnet, manager 0xdceb4ba0…dd2b5, 2026-09-15, while the live bid from
// tick 4 was resting and then after it filled:
//
//   resting  → lockedBalance {base: 0,  quote: 0.4174}   open_orders 1
//   filled   → lockedBalance {base: 20, quote: 0}        open_orders 0,
//                                                        settled_balances {base: 20}
//
// The second reading is 20 DEEP of unswept fill proceeds. They are ours, but this
// tick's PTB cannot spend them: `withdrawSettledAmounts` is its LAST command, so it
// sweeps after the places. Counting them would size an ask the manager cannot back at
// the moment it is placed. Hence `min(ownOrderLock, lockedBalance)`.
// -----------------------------------------------------------------------------

test('ownOrderLock derives the lock per side from the resting set', () => {
	const lock = ownOrderLock([
		{ orderId: 'b', isBid: true, price: 0.02086, quantity: 20 },
		{ orderId: 'a', isBid: false, price: 0.0211, quantity: 15 },
	])
	// A bid locks quote: 20 × 0.02086 = 0.4172 SUI. An ask locks base: 15 DEEP.
	assert.equal(Math.abs(lock.quote - 20 * 0.02086) < 1e-9, true)
	assert.equal(lock.base, 15)
})

test('unswept fill proceeds are not treated as spendable', () => {
	// The state right after the live bid filled: nothing resting, no DEEP available,
	// and lockedBalance reporting 20 DEEP that is really settled_balances. The ask must
	// NOT be planned — those 20 DEEP arrive in the manager only once a tick's trailing
	// `withdrawSettledAmounts` has swept them, which is next tick.
	const plan = planQuotes(
		base({
			mid: TICK3_MID,
			orderSize: LIVE_SIZE,
			baseInventory: 0,
			quoteInventory: 0.0326,
			baseLocked: 20, // settled, not locked in an order
			quoteLocked: 0,
			resting: [],
		}),
	)

	assert.deepEqual(plan.cancels, [])
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['quote_below_size', 'base_below_size'])
})

test('once swept, the same DEEP is available and the ask is quoted', () => {
	// The next tick. The sweep moved the 20 DEEP into the BalanceManager, so it shows up
	// as available base and the ask is planned normally. Same coins, one tick later.
	const plan = planQuotes(
		base({ mid: TICK3_MID, orderSize: LIVE_SIZE, baseInventory: 20, quoteInventory: 0.0326, baseLocked: 0, quoteLocked: 0, resting: [] }),
	)

	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, false)
	assert.equal(plan.place[0].quantity, LIVE_SIZE)
	assert.deepEqual(plan.skippedSides, ['quote_below_size'])
})

test('a stale resting order cannot conjure funds the chain says are gone', () => {
	// `state.resting` still lists the bid, but it filled — so the chain reports no quote
	// locked at all. `ownOrderLock` would claim 0.417 SUI; the chain figure caps it at 0,
	// and the bid is skipped instead of being sized against money that is not there.
	const plan = planQuotes(tick3({ mid: 0.021, quoteLocked: 0 }))

	assert.deepEqual(plan.cancels, ['384799081396027990783441320029'])
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['quote_below_size', 'base_below_size'])
})

// -----------------------------------------------------------------------------
// The one-sided-start inventory transition, at 100 DEEP size
// -----------------------------------------------------------------------------

/**
 * An earlier sizing plan said the ask side "sizes to the DEEP the manager actually holds
 * (20 now; fills buy more), so 100 is the ceiling per side, not a requirement to hold
 * 100 DEEP up front." That is wrong, and the code says so plainly: `quotes.ts:246` sets
 * `quantity = floorToLot(orderSize, lotSize)` — the order size, always, never resized
 * to inventory — and a side that cannot back that quantity is pushed to `skippedSides`
 * and skipped.
 *
 * So at `ORDER_SIZE=100` with 20 DEEP the run is BID-ONLY, and it stays bid-only until
 * the manager actually holds 100 DEEP. These tests fix that as behaviour rather than as
 * a promise, and walk the transition one step at a time.
 *
 * Mid 0.01961 is a live DEEP/SUI read on 2026-09-24; the manager's 20 DEEP and
 * 0.0326 SUI are its real balances the same day (`account('DEEP_SUI','MAKER')`:
 * `settled_balances.base = 20`, `open_orders` empty).
 */
const C_MID = 0.01961
const C_SIZE = 100

function optionC(overrides: Partial<PlanQuotesInput> = {}): PlanQuotesInput {
	return base({ mid: C_MID, orderSize: C_SIZE, baseInventory: 0, quoteInventory: 0, resting: [], ...overrides })
}

test('one-sided start at 100 DEEP with 20 DEEP held: bid only, ask skipped for size', () => {
	const plan = planQuotes(optionC({ baseInventory: 20, quoteInventory: 2.5 }))

	assert.equal(plan.place.length, 1, 'one side, not two')
	assert.equal(plan.place[0].isBid, true)
	assert.equal(plan.place[0].quantity, 100, 'the bid is the full order size, not sized down')
	assert.deepEqual(plan.skippedSides, ['base_below_size'])
})

test('the ask is still skipped at 99 DEEP — it is a threshold, not a taper', () => {
	const plan = planQuotes(optionC({ baseInventory: 99, quoteInventory: 2.5 }))
	assert.equal(plan.place.length, 1)
	assert.equal(plan.place[0].isBid, true)
	assert.deepEqual(plan.skippedSides, ['base_below_size'])
})

test('at exactly 100 DEEP the ask appears, and the run is two-sided', () => {
	const plan = planQuotes(optionC({ baseInventory: 100, quoteInventory: 2.5 }))

	assert.equal(plan.place.length, 2)
	assert.deepEqual(plan.skippedSides, [])
	const ask = plan.place.find((o) => !o.isBid)!
	assert.equal(ask.quantity, 100)
	assert.ok(ask.price > C_MID)
})

test('the transition needs five 20-DEEP bid fills, and nothing shorter', () => {
	// The run starts holding 20. Each filled bid at ORDER_SIZE=100 would add 100 — but
	// the bid that can be BACKED is what matters, and the quote inventory is what limits
	// it. Walk the base inventory up and record where the ask switches on.
	const firstTwoSided = [20, 40, 60, 80, 99, 100].find(
		(deep) => planQuotes(optionC({ baseInventory: deep, quoteInventory: 2.5 })).place.length === 2,
	)
	assert.equal(firstTwoSided, 100, 'nothing below the full order size produces an ask')
})

test('a bid that cannot be backed leaves the run quoting nothing at all', () => {
	// 2.5 SUI backs a 100 DEEP bid at 0.0196 (1.96 SUI needed). 1.5 SUI does not. This is
	// the state the budget has to avoid: a funded run that quotes neither side still
	// submits a settle-only transaction every tick and still burns gas.
	const plan = planQuotes(optionC({ baseInventory: 20, quoteInventory: 1.5 }))
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['quote_below_size', 'base_below_size'])
})

test('the manager as it stands today can back neither side at 100 DEEP', () => {
	// baseInventory 0 because the 20 DEEP is SETTLED, not swept: `checkManagerBalance`
	// reads 0 and `withdrawSettledAmounts` is the last command in the tick's PTB, so it
	// lands after the places. Read on chain 2026-09-24.
	const plan = planQuotes(optionC({ baseInventory: 0, quoteInventory: 0.0326, baseLocked: 20 }))
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['quote_below_size', 'base_below_size'])
})

test('without a deposit the run is ASK-only, and only below 20 DEEP', () => {
	// The state after the first tick sweeps: 20 DEEP and 0.0326 SUI in the manager.
	// 0.0326 SUI at 0.0196 buys 1.66 DEEP and the pool minimum is 10, so NO bid is
	// backable at any size. The ask is, up to the 20 DEEP held. So on current funds the
	// loop does not market-make at all — it sells inventory and then quotes nothing.
	const sizes = [10, 20, 21, 100]
	const quoted = sizes.map((size) => {
		const plan = planQuotes(optionC({ orderSize: size, baseInventory: 20, quoteInventory: 0.0326 }))
		return { size, bids: plan.place.filter((o) => o.isBid).length, asks: plan.place.filter((o) => !o.isBid).length }
	})
	assert.deepEqual(quoted, [
		{ size: 10, bids: 0, asks: 1 },
		{ size: 20, bids: 0, asks: 1 },
		{ size: 21, bids: 0, asks: 0 },
		{ size: 100, bids: 0, asks: 0 },
	])
})

test('a deposit is what turns the bid back on, and 0.5 SUI is not enough for 100 DEEP', () => {
	// 100 DEEP at 0.0196 needs 1.96 SUI behind the bid. The wallet holds 0.946 SUI in
	// total, so no deposit it can fund backs a 100 DEEP bid. 25 DEEP is the largest the
	// wallet could back if it deposited nearly everything — and then there is no gas.
	const at = (quote: number, size: number) =>
		planQuotes(optionC({ orderSize: size, baseInventory: 20, quoteInventory: quote })).place.filter((o) => o.isBid).length

	assert.equal(at(0.5326, 100), 0, '0.5 SUI deposited does not back a 100 DEEP bid')
	assert.equal(at(0.5326, 25), 1, 'it does back 25 DEEP')
	assert.equal(at(0.9786, 100), 0, 'even the whole wallet does not reach 100 DEEP')
	assert.equal(at(1.96, 100), 1, '1.96 SUI is where the 100 DEEP bid becomes backable')
})

// The 2026-09-25 failure, replayed: state held a bid that had filled, and the chain held
// a bid from the killed run that state did not know.
test('reconcile: filled order dropped, orphan adopted with side and price decoded from its id', () => {
	const DIV = 1e12 // floatScalar 1e9 × quoteScalar 1e9 / baseScalar 1e6
	const stale = { orderId: '386459288362661850428880708317', isBid: true, price: 0.02095, quantity: 20 }
	const orphan = '380740797699811889427920709799' // decodes to bid @ 0.02064
	const r = reconcileResting([stale], [{ orderId: orphan, remaining: 20 }], DIV)
	assert.deepEqual(r.dropped, [stale.orderId])
	assert.deepEqual(r.adopted, [orphan])
	assert.equal(r.resting.length, 1)
	assert.equal(r.resting[0].isBid, true)
	assert.ok(Math.abs(r.resting[0].price - 0.02064) < 1e-12)
	// The planner's own-lock figure now matches the chain's 0.4128 locked, not 0.419.
	assert.ok(Math.abs(ownOrderLock(r.resting).quote - 0.4128) < 1e-9)
})

test('reconcile: an ask id decodes as an ask', () => {
	const d = decodeOrderId('170141183846928520075902410071106757568', 1e12)
	assert.equal(d.isBid, false)
	assert.ok(Math.abs(d.price - 0.02095) < 1e-12)
})

test('reconcile: partly filled order is resized, fully matched order untouched', () => {
	const a = { orderId: '1', isBid: true, price: 0.02, quantity: 20 }
	const b = { orderId: '2', isBid: false, price: 0.021, quantity: 20 }
	const r = reconcileResting([a, b], [{ orderId: '1', remaining: 7 }, { orderId: '2', remaining: 20 }], 1e12)
	assert.deepEqual(r.resized, ['1'])
	assert.deepEqual(r.dropped, [])
	assert.deepEqual(r.adopted, [])
	assert.equal(r.resting.find((o) => o.orderId === '1')?.quantity, 7)
})

test('reconcile: empty chain list drops everything (caller must not pass a failed read)', () => {
	const r = reconcileResting([{ orderId: '1', isBid: true, price: 0.02, quantity: 20 }], [], 1e12)
	assert.deepEqual(r.dropped, ['1'])
	assert.equal(r.resting.length, 0)
})

test('25 Sep 18:26Z, replayed: 1 DEEP + 0.39684 SUI at 20 DEEP quotes nothing, without error', () => {
	// A mainnet run went idle here: the account could back neither a 20 DEEP ask nor a
	// 20 DEEP bid at ~0.0199. The planner must say so and place nothing — never a
	// smaller clip, never an exception.
	const plan = planQuotes(
		base({ mid: 0.0199, orderSize: 20, baseInventory: 1, quoteInventory: 0.39684, requoteToleranceBps: 50 }),
	)
	assert.deepEqual(plan.place, [])
	assert.deepEqual(plan.skippedSides, ['quote_below_size', 'base_below_size'])
})

test('a partly filled 19 DEEP order is replaced by a full clip, never kept below size', () => {
	// Fill 28 on 25 Sep matched 19 of 20 DEEP. A resting order whose size no longer
	// matches the clip is not "within tolerance": it is cancelled and a full clip placed.
	const resting = [{ orderId: '170141183829035178324404145003586771217', isBid: false, price: ASK_TARGET, quantity: 19 }]
	const plan = planQuotes(base({ resting, orderSize: 20 }))
	assert.ok(plan.cancels.includes(resting[0].orderId))
	const ask = plan.place.find((o) => !o.isBid)
	assert.equal(ask?.quantity, 20)
	assert.ok(plan.place.every((o) => o.quantity >= MIN_SIZE))
})

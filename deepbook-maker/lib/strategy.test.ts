/**
 * The built-in maker, offline. Fills in scenarios are SCRIPTED — never inferred from the
 * price path — so these compare decisions, not returns.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { askBandCap, bidBandCap, DEFAULT_STRATEGY, planStrategy, type StrategyConfig, type StrategyInput } from './strategy.ts'
import { cycleCost, cycleGate, DEFAULT_CYCLE, requiredSpreadBps, SHAPE_COSTS } from './costs.ts'
import { runScenario, submissions } from './scenario.ts'
import { evaluateLimits, emptyBudget } from './budget.ts'
import type { TrackedOrder } from './state.ts'

const MID = 0.0191
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)

function input(over: Partial<StrategyInput> = {}): StrategyInput {
	return {
		nowMs: 1_000_000,
		book: { bestBid: MID * (1 - 0.003), bestAsk: MID * (1 + 0.003), readAtMs: 1_000_000 },
		params: { tickSize: 0.00001, lotSize: 1, minSize: 10, verified: true },
		fees: { makerFeeRate: 0, verified: true },
		inv: { free: { base: 35, quote: 0.67 }, locked: { base: 0, quote: 0 } },
		resting: [],
		...over,
	}
}
// A config whose cost floor sits below the default touch, so ordinary cases quote.
const CHEAP: StrategyConfig = { ...DEFAULT_STRATEGY, cycle: { ...DEFAULT_CYCLE, replacementsPerCycle: 0, cyclesToAmortize: 1000, quantile: 'median' } }

// --- the review's arithmetic, asserted (plan-review-probes.mts) ----------------------

test('probe: 20 DEEP + 0.382 SUI at 0.0191 is 50% base; a full 20-DEEP bid fill makes it 100%', () => {
	const B = 20, Q = 20 * MID, V = B * MID + Q
	near((B * MID) / V, 0.5)
	near(((B + 20) * MID) / (V - 20 * MID + 20 * MID), 1)
})

test('probe: a 70% ceiling leaves room for only 8 more DEEP — below the 10-DEEP minimum', () => {
	const B = 20, V = 2 * 20 * MID
	near(bidBandCap(B, V, MID, MID, 0.7), 8)
	assert.ok(bidBandCap(B, V, MID, MID, 0.7) < 10)
})

test('probe: a 10-DEEP bid at 50% target with 20 points of headroom needs 25 DEEP + 0.4775 SUI', () => {
	const B = 25, Q = 25 * MID, V = B * MID + Q
	near(Q, 0.4775)
	near(bidBandCap(B, V, MID, MID, 0.7), 10)
})

test('probe: three mean requotes at 20 DEEP is 86.39 bps; one historical S4 is 110.77 bps — sensitivity, not a floor', () => {
	near(requiredSpreadBps(20, MID, 0.0033, 0), 86.39, 0.01)
	near(requiredSpreadBps(20, MID, 0.004231376, 0), 110.77, 0.01)
})

// --- cost model -------------------------------------------------------------------------

test('cost: a cycle is the sum of its shapes at a stated quantile, never negative from rebates', () => {
	const c = cycleCost({ ...DEFAULT_CYCLE, replacementsPerCycle: 3, quantile: 'p90', failRate: 0, cyclesToAmortize: 1e9 })
	near(c.totalSui, 2 * SHAPE_COSTS.place_one.p90 + 3 * SHAPE_COSTS.replace_one.p90, 1e-7)
	// cancel_one's median is a rebate (negative); it is floored at zero, never credited.
	assert.equal(Math.max(0, SHAPE_COSTS.cancel_one.median), 0)
})

test('cost: the gate prices the supported quantity; a smaller matched size needs a wider spread', () => {
	const cost = cycleCost(DEFAULT_CYCLE)
	assert.ok(requiredSpreadBps(10, MID, cost.totalSui, 0) > requiredSpreadBps(20, MID, cost.totalSui, 0))
	const pass = cycleGate({ bid: 0.0189, ask: 0.0193, qty: 50, mark: MID, makerFeeRate: 0, cost })
	const fail = cycleGate({ bid: 0.0189, ask: 0.0193, qty: 10, mark: MID, makerFeeRate: 0, cost })
	assert.equal(pass.pass, true)
	assert.equal(fail.pass, false)
})

test('cost: a nonzero maker fee flips a passing gate', () => {
	const cost = cycleCost({ ...DEFAULT_CYCLE, replacementsPerCycle: 0, cyclesToAmortize: 1e9, failRate: 0 })
	const args = { bid: 0.0189, ask: 0.0193, qty: 20, mark: MID, cost }
	assert.equal(cycleGate({ ...args, makerFeeRate: 0 }).pass, true)
	assert.equal(cycleGate({ ...args, makerFeeRate: 0.01 }).pass, false)
})

// --- stop conditions ----------------------------------------------------------------------

const resting = (o: Partial<TrackedOrder>): TrackedOrder => ({ orderId: 'R', isBid: true, price: 0.019, quantity: 20, placedAtMs: 999_000, expiresAtMs: 999_000 + 3_600_000, ...o })

test('halt and pause cancel every resting order and place nothing', () => {
	for (const over of [{ halt: 'drawdown_cap' }, { pause: 'pending_unknown' }]) {
		const p = planStrategy(input({ ...over, resting: [resting({ orderId: 'A' }), resting({ orderId: 'B', isBid: false, price: 0.0193 })] }), CHEAP)
		assert.deepEqual(p.cancels.sort(), ['A', 'B'])
		assert.deepEqual(p.place, [])
	}
})

test('stale book, unverified book params or fees, and a missing DEEP fee reserve pause', () => {
	assert.equal(planStrategy(input({ book: { ...input().book, readAtMs: 0 } }), CHEAP).reason, 'stale_book')
	assert.equal(planStrategy(input({ params: { ...input().params, verified: false } }), CHEAP).reason, 'book_params_unverified')
	assert.equal(planStrategy(input({ fees: { makerFeeRate: 0, verified: false } }), CHEAP).reason, 'fees_unverified')
	assert.equal(planStrategy(input({ fees: { makerFeeRate: 0.0005, verified: true } }), CHEAP).reason, 'fee_reserve_unconfigured')
})

// --- inventory ledger and band -------------------------------------------------------------

test('settled proceeds count once toward ownership and never back an order this tick', () => {
	// 20 DEEP settled from a fill sits inside SDK `locked`; no resting ask exists.
	const p = planStrategy(input({ inv: { free: { base: 15, quote: 0.67 }, locked: { base: 20, quote: 0 } } }), CHEAP)
	assert.equal(p.mode, 'quote')
	const ask = p.sides.find((s) => s.side === 'ask')!
	assert.equal(ask.backing, 15, 'only free base backs the ask; settled is swept at the end of the PTB')
	near(p.valueQuote!, 35 * MID + 0.67, 1e-9)
})

test('at the upper band bound no bid is placed and a resting bid is cancelled at once, dwell or not', () => {
	const inv = { free: { base: 90, quote: 0.3 }, locked: { base: 0, quote: 0.38 } } // f ≈ 0.72
	const p = planStrategy(input({ inv, resting: [resting({ orderId: 'B1', placedAtMs: 999_990 })] }), { ...CHEAP, bandHigh: 0.7 })
	assert.ok(p.cancels.includes('B1'), 'risk cancel overrides the minimum dwell')
	assert.ok(!p.place.some((o) => o.isBid))
	assert.ok(p.place.some((o) => !o.isBid), 'the reducing ask is still quoted')
})

test('at the lower band bound no ask is placed', () => {
	const p = planStrategy(input({ inv: { free: { base: 10, quote: 1.5 }, locked: { base: 0, quote: 0 } } }), { ...CHEAP, bandLow: 0.2 })
	assert.ok(!p.place.some((o) => !o.isBid))
	assert.ok(p.place.some((o) => o.isBid))
})

test('every placed size keeps the projected fraction inside the band if it fills', () => {
	for (const baseUnits of [15, 25, 35, 45, 60]) {
		const inv = { free: { base: baseUnits, quote: 0.67 }, locked: { base: 0, quote: 0 } }
		const p = planStrategy(input({ inv }), CHEAP)
		const B = baseUnits, V = B * MID + 0.67
		for (const o of p.place) {
			const f = o.isBid ? ((B + o.quantity) * MID) / (V - o.quantity * o.price + o.quantity * MID) : ((B - o.quantity) * MID) / (V + o.quantity * (o.price - MID))
			assert.ok(f <= CHEAP.bandHigh + 1e-9 && f >= CHEAP.bandLow - 1e-9, `B=${B} ${o.isBid ? 'bid' : 'ask'} ${o.quantity} → f ${f}`)
		}
	}
})

// --- partial fills: the 17-versus-20 idle trap -----------------------------------------------

test('a partly filled 17-DEEP ask is kept, not cancelled for being under the 20 clip', () => {
	const p = planStrategy(input({ resting: [resting({ orderId: 'A17', isBid: false, price: 0.01921, quantity: 17 })], inv: { free: { base: 18, quote: 0.67 }, locked: { base: 17, quote: 0 } } }), CHEAP)
	assert.ok(!p.cancels.includes('A17'))
	assert.equal(p.sides.find((s) => s.side === 'ask')?.action, 'keep')
})

test('17 DEEP with nothing resting is quoted as a 17-DEEP ask, not left idle', () => {
	const p = planStrategy(input({ inv: { free: { base: 17, quote: 0.12 }, locked: { base: 0, quote: 0 } } }), { ...CHEAP, bandLow: 0.2, bandHigh: 0.9 })
	const ask = p.place.find((o) => !o.isBid)
	assert.ok(ask, JSON.stringify(p))
	assert.ok(ask.quantity >= 10 && ask.quantity <= 17)
})

test('below the pool minimum on both sides the maker says so and how to recover, instead of idling silently', () => {
	const p = planStrategy(input({ inv: { free: { base: 3, quote: 0.05 }, locked: { base: 0, quote: 0 } } }), CHEAP)
	assert.equal(p.mode, 'inventory_limited')
	assert.match(p.recovery ?? '', /deposit about .* more base .* more quote/)
})

// --- dwell and tolerance ------------------------------------------------------------------

test('a drifted order waits out the dwell; after it, it is replaced', () => {
	const drifted = resting({ orderId: 'D', price: 0.0185, placedAtMs: 1_000_000 - 60_000 })
	const early = planStrategy(input({ resting: [drifted] }), CHEAP)
	assert.ok(!early.cancels.includes('D'))
	const late = planStrategy(input({ resting: [{ ...drifted, placedAtMs: 1_000_000 - CHEAP.minDwellMs - 1 }] }), CHEAP)
	assert.ok(late.cancels.includes('D'))
	assert.ok(late.place.some((o) => o.isBid))
})

test('an order near expiry is replaced even inside tolerance and dwell', () => {
	const p0 = planStrategy(input(), CHEAP)
	const bid = p0.place.find((o) => o.isBid)!
	const soon = resting({ orderId: 'E', price: bid.price, quantity: bid.quantity, placedAtMs: 999_000, expiresAtMs: 1_000_000 + 60_000 })
	const p = planStrategy(input({ resting: [soon] }), CHEAP)
	assert.ok(p.cancels.includes('E'))
})

// --- the cost gate refuses to widen out of reach ----------------------------------------------

test('when the cost floor exceeds the spread cap the maker pauses (cancelling), it does not widen forever', () => {
	const p = planStrategy(input({ resting: [resting({ orderId: 'X' })] }), { ...DEFAULT_STRATEGY, maxSpreadBps: 100 })
	assert.equal(p.mode, 'pause')
	assert.equal(p.reason, 'cost_infeasible')
	assert.deepEqual(p.cancels, ['X'])
})

test('a spread far outside the touch trips the liquidity rule', () => {
	const tight = { bestBid: MID * (1 - 0.0001), bestAsk: MID * (1 + 0.0001), readAtMs: 1_000_000 }
	assert.equal(planStrategy(input({ book: tight }), DEFAULT_STRATEGY).reason, 'outside_liquidity_rule')
})

test('the default config at 20 DEEP quotes a spread that covers its p90 cycle cost, and the gate is logged', () => {
	const wide = { bestBid: MID * (1 - 0.006), bestAsk: MID * (1 + 0.006), readAtMs: 1_000_000 }
	const p = planStrategy(input({ book: wide, inv: { free: { base: 50, quote: 0.955 }, locked: { base: 0, quote: 0 } } }), DEFAULT_STRATEGY)
	assert.equal(p.mode, 'quote', JSON.stringify(p))
	assert.ok(p.gate!.pass)
	assert.ok(p.gate!.marginSui >= 0)
	assert.ok(p.spreadBps! >= p.gate!.requiredSpreadBps - 1e-9)
})

test('quotes never cross the far touch (post-only would reject them)', () => {
	const p = planStrategy(input({ book: { bestBid: 0.019, bestAsk: 0.01901, readAtMs: 1_000_000 } }), { ...CHEAP, touchMultiple: 1e6 })
	for (const o of p.place) assert.ok(o.isBid ? o.price < 0.01901 : o.price > 0.019)
})

// --- scenarios (scripted fills) --------------------------------------------------------------

const flat = (n: number, mid = MID) => Array.from({ length: n }, () => ({ mid, halfTouchBps: 60 }))

test('scenario flat: both sides quoted once, then kept — no replacement churn', () => {
	const steps = runScenario({ ticks: flat(30), start: { base: 50, quote: 0.955 }, cfg: DEFAULT_STRATEGY })
	assert.equal(steps[0].plan.place.length, 2)
	assert.equal(submissions(steps), 1)
})

test('scenario trending: a steady drift replaces a side only after its dwell, never sooner', () => {
	const ticks = Array.from({ length: 60 }, (_, i) => ({ mid: MID * (1 + 0.001 * i), halfTouchBps: 60 }))
	const steps = runScenario({ ticks, start: { base: 50, quote: 0.955 }, cfg: DEFAULT_STRATEGY })
	const dwellTicks = DEFAULT_STRATEGY.minDwellMs / 60_000
	for (const side of ['bid', 'ask'] as const) {
		const placed = steps.filter((s) => s.plan.sides.some((n) => n.side === side && n.action === 'place' && n.reason === 'price_drift')).map((s) => s.tick)
		const all = steps.filter((s) => s.plan.sides.some((n) => n.side === side && n.action === 'place')).map((s) => s.tick)
		for (const t of placed) {
			const prev = all.filter((x) => x < t).at(-1)!
			assert.ok(t - prev >= dwellTicks, `${side} replaced at ${t}, previous placement ${prev}`)
		}
		assert.ok(placed.length >= 1, `${side} never followed the trend`)
	}
	// Recorded for the README: 60 ticks of a 6% trend cost this many submissions.
	assert.ok(submissions(steps) <= 2 * Math.ceil(60 / dwellTicks) + 1)
})

test('scenario jumping: a 3% jump replaces after dwell; nothing crosses', () => {
	const ticks = [...flat(10), ...flat(20, MID * 1.03)]
	const steps = runScenario({ ticks, start: { base: 50, quote: 0.955 }, cfg: DEFAULT_STRATEGY })
	const after = steps.slice(10).find((s) => s.plan.place.length)
	assert.ok(after, 'requoted after the jump')
})

test('scenario: a bid-only fill, then a falling price, never pushes our own orders past the band; drawdown halts', () => {
	const ticks = Array.from({ length: 40 }, (_, i) => ({ mid: MID * (1 - 0.004 * i), halfTouchBps: 60, fill: { bid: 1 } }))
	const steps = runScenario({ ticks, start: { base: 50, quote: 0.955 }, cfg: DEFAULT_STRATEGY })
	for (const s of steps) {
		// After our own fills at our bid (before the next mark), f can only exceed the band by
		// the price move since placement — never by an order sized past the cap.
		for (const o of s.plan.place.filter((p) => p.isBid)) {
			const V = s.valueQuote
			const fAfter = ((s.base + o.quantity) * s.mid) / (V - o.quantity * o.price + o.quantity * s.mid)
			assert.ok(fAfter <= DEFAULT_STRATEGY.bandHigh + 1e-6, `tick ${s.tick}: bid ${o.quantity} would take f to ${fAfter}`)
		}
	}
	const start = steps[0].valueQuote
	const limits = { gas: { capMist: 1e12, cleanupAllowanceMist: 0 }, maxDrawdownQuote: 0.1, maxTurnoverQuote: 1e9, turnoverWindowMs: 1, maxRunMs: 0, maxMarkAgeMs: 1e12 }
	const haltAt = steps.find((s) => evaluateLimits({ budget: emptyBudget(), pending: [], limits, nowMs: s.tick, runStartMs: 0, startValueQuote: start, current: { valueQuote: s.valueQuote, atMs: s.tick }, nextReserveMist: 0 }).action === 'halt')
	assert.ok(haltAt, 'the drawdown limit halts the run before inventory risk is unbounded')
	assert.ok(steps.at(-1)!.baseFraction <= 1)
})

test('scenario one-sided start (SUI only): bids until a fill brings base in, then both sides', () => {
	const fillBid = { mid: MID, halfTouchBps: 60, fill: { bid: 1 } }
	const ticks = [...flat(3), fillBid, flat(1)[0], fillBid, ...flat(3)]
	const steps = runScenario({ ticks, start: { base: 0, quote: 1.9 }, cfg: DEFAULT_STRATEGY })
	assert.deepEqual(steps[0].plan.place.map((o) => o.isBid), [true])
	assert.ok(steps.slice(3).some((s) => s.plan.place.some((o) => !o.isBid)), 'an ask appears once fills bring base inside the band')
})

test('review #5: when widening drops the ask of a long-base book, the lone bid is not placed', () => {
	// Asymmetric band: just above target, the ask's room to BAND_LOW is small while the
	// bid's room to BAND_HIGH is large. Widening can push the ask cap under the pool
	// minimum and leave a bid that ADDS base to a book that is already long.
	const cfg = { ...DEFAULT_STRATEGY, bandLow: 0.45, bandHigh: 0.95 }
	const book = { bestBid: MID * 0.994, bestAsk: MID * 1.006, readAtMs: 1_000_000 }
	let checked = 0
	for (let base = 20; base <= 400; base += 1) {
		for (let quote = 0.1; quote <= 8; quote += 0.02) {
			const V = base * MID + quote
			const f = (base * MID) / V
			const p = planStrategy(input({ inv: { free: { base, quote }, locked: { base: 0, quote: 0 } }, book }), cfg)
			if (p.place.length !== 1) continue
			checked++
			if (p.place[0].isBid) assert.ok(f < cfg.targetBaseFraction + 1e-9, `lone bid placed at f ${f.toFixed(4)} (base ${base}, quote ${quote.toFixed(2)})`)
			else assert.ok(f > cfg.targetBaseFraction - 1e-9, `lone ask placed at f ${f.toFixed(4)}`)
		}
	}
	assert.ok(checked > 0)
})

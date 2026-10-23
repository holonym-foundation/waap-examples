import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_STRATEGY } from './strategy.ts'
import { renderReportCard, reportCard } from './report.ts'
import { replayTrades, touchSeries, type Trade } from './replay.ts'

const MIN = 60_000
const T0 = Date.parse('2026-10-22T00:00:00Z')
const tr = (min: number, price: number, takerIsBid: boolean, qty = 500): Trade => ({ timestamp: T0 + min * MIN, price, base_volume: qty, taker_is_bid: takerIsBid })

/** A quiet two-sided tape around `mid`: a taker buy at the ask and a taker sell at the bid every minute. */
function flatTape(minutes: number, mid = 0.0184, halfBps = 5): Trade[] {
	const out: Trade[] = []
	for (let m = 0; m <= minutes; m++) {
		out.push(tr(m, +(mid * (1 + halfBps / 1e4)).toFixed(5), true))
		out.push(tr(m + 0.5, +(mid * (1 - halfBps / 1e4)).toFixed(5), false))
	}
	return out
}

const OPTS = {
	cfg: DEFAULT_STRATEGY,
	params: { tickSize: 0.00001, lotSize: 1, minSize: 10 },
	makerFeeRate: 0,
	startBase: 200,
	startQuote: 3.8,
	pollMs: MIN,
	costPerSendQuote: 0.0014,
	fromMs: T0 + 2 * MIN,
	toMs: T0 + 60 * MIN,
}

test('the touch comes from the last taker buy and sell prints, and goes stale after 10 minutes', () => {
	const { touch, midAt } = touchSeries([tr(0, 0.0185, true), tr(1, 0.0183, false)])
	assert.deepEqual(touch(T0 + 2 * MIN), { bid: 0.0183, ask: 0.0185 })
	assert.equal(midAt(T0 + 2 * MIN), 0.0184)
	assert.equal(touch(T0 + 12 * MIN), undefined)
})

test('a flat tape that never reaches our quotes fills nothing, and gas is the only result', () => {
	const r = replayTrades(flatTape(60), OPTS)
	assert.equal(r.fills.length, 0)
	assert.ok(r.sends >= 1, 'the first quote is a send')
	const c = reportCard({ fills: r.fills, endMid: r.endMid, gasQuote: r.gasQuote, sends: r.sends, midAt: r.midAt, startMs: OPTS.fromMs, endMs: OPTS.toMs })
	assert.equal(c.tradingPnlQuote, 0)
	assert.equal(c.resultQuote, -r.gasQuote)
	assert.match(renderReportCard(c).join('\n'), /no fills/)
})

test('a taker sweep through our bid fills it at OUR price, capped at the order size', () => {
	const tape = flatTape(60)
	tape.push(tr(30, 0.0175, false, 1000)) // a taker sell far through the bid
	const r = replayTrades(tape, OPTS)
	const bids = r.fills.filter((f) => f.isBid)
	assert.equal(bids.length, 1)
	assert.equal(bids[0].quantity, 100)
	assert.ok(bids[0].price > 0.0175, 'filled at our resting price, not the sweep print')
})

test('an equal-price print does not fill us unless REPLAY_FILL_AT_PRICE: queue position is unknown', () => {
	const probe = replayTrades(flatTape(60), OPTS)
	assert.equal(probe.fills.length, 0)
	// Find our resting bid price by replaying a sweep and reading the fill price.
	const sweep = replayTrades([...flatTape(60), tr(30, 0.0175, false, 1000)], OPTS)
	const ourBid = sweep.fills.find((f) => f.isBid)!.price
	const atPrice = [...flatTape(60), tr(30, ourBid, false, 1000)]
	assert.equal(replayTrades(atPrice, OPTS).fills.length, 0)
	assert.equal(replayTrades(atPrice, { ...OPTS, fillAtPrice: true }).fills.filter((f) => f.isBid).length, 1)
})

test('report card: a bid filled below mid, then marked lower, shows edge at fill and adverse selection', () => {
	const fills = [{ atMs: T0 + 10 * MIN, isBid: true, price: 0.0183, quantity: 100 }]
	const midAt = (ms: number) => (ms < T0 + 10 * MIN ? 0.0184 : 0.0180)
	const c = reportCard({ fills, endMid: 0.018, gasQuote: 0.001, sends: 1, midAt, startMs: T0, endMs: T0 + 60 * MIN })
	assert.equal(+c.spreadAtFillQuote!.toFixed(6), 0.01) // (0.0184 − 0.0183) × 100
	assert.equal(+c.markout30mQuote!.toFixed(6), -0.03) // (0.0180 − 0.0183) × 100
	assert.equal(+c.tradingPnlQuote.toFixed(6), -0.03)
	assert.equal(+c.resultQuote.toFixed(6), -0.031)
	assert.match(renderReportCard(c).join('\n'), /adverse selection/)
})

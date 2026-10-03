import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeOrderId, distanceBps, ownOrderLock, reconcileResting, roundToTick } from './quotes.ts'

// Pure helpers the strategy builds on. The old `planQuotes` planner and its 25 tests were
// retired on 2026-09-28: its fixed clip left a partly filled order idle (17 < 20) and it had
// no inventory band or cost gate. `lib/strategy.ts` replaces it; `lib/strategy.test.ts`
// covers the same situations (SUI-only start, locked funds, unswept proceeds, partial fills).

test('prices snap to the tick grid in the requested direction, without float dust', () => {
	assert.equal(roundToTick(0.021338, 0.00001, 'down'), 0.02133)
	assert.equal(roundToTick(0.021331, 0.00001, 'up'), 0.02134)
	assert.ok(Math.abs(distanceBps(0.0202, 0.02) - 100) < 1e-9)
})

test('ownOrderLock derives the lock per side from the resting set', () => {
	const lock = ownOrderLock([
		{ orderId: 'b', isBid: true, price: 0.02086, quantity: 20 },
		{ orderId: 'a', isBid: false, price: 0.0211, quantity: 15 },
	])
	// A bid locks quote: 20 × 0.02086 = 0.4172 SUI. An ask locks base: 15 DEEP.
	assert.equal(Math.abs(lock.quote - 20 * 0.02086) < 1e-9, true)
	assert.equal(lock.base, 15)
})

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


import test from 'node:test'
import assert from 'node:assert/strict'

import { realizedSpread } from './spread.ts'

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`)

test('a buy with no sell earns no spread, however the price moved', () => {
	// This is the 2026-09-15 run exactly: one bid filled, nothing sold. Counting the
	// 0.4174 SUI that left the manager as "spread earned" would be nonsense, and
	// counting the DEEP received at a higher mid as profit would be marking, not earning.
	const r = realizedSpread({
		fills: [{ isBid: true, price: 0.02087, quantity: 20 }],
		openingBase: 0,
		openingBasis: 0.02087,
		closingMid: 0.03,
	})
	assert.equal(r.realizedSui, 0)
	assert.equal(r.matchedBase, 0)
	assert.equal(r.openBase, 20)
	near(r.unrealizedSui, (0.03 - 0.02087) * 20)
})

test('a buy then a sell realizes exactly the spread between them', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: true, price: 0.0196, quantity: 100 },
			{ isBid: false, price: 0.0198, quantity: 100 },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.0197,
	})
	assert.equal(r.matchedBase, 100)
	near(r.realizedSui, (0.0198 - 0.0196) * 100)
	assert.equal(r.openBase, 0)
	assert.equal(r.unrealizedSui, 0)
})

test('opening inventory is matched at its stated basis, not at the opening mid', () => {
	// The 20 DEEP this manager holds was bought at 0.02087 on 2026-09-15. Selling it at
	// 0.0198 REALIZES A LOSS, and the convention has to say so rather than book the
	// 0.396 SUI of proceeds as spread earned.
	const r = realizedSpread({
		fills: [{ isBid: false, price: 0.0198, quantity: 20 }],
		openingBase: 20,
		openingBasis: 0.02087,
		closingMid: 0.0197,
	})
	assert.equal(r.matchedBase, 20)
	near(r.realizedSui, (0.0198 - 0.02087) * 20)
	assert.ok(r.realizedSui < 0)
	assert.equal(r.openBase, 0)
})

test('FIFO: the oldest lot is matched first', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: true, price: 0.01, quantity: 10 },
			{ isBid: true, price: 0.02, quantity: 10 },
			{ isBid: false, price: 0.03, quantity: 10 },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.03,
	})
	near(r.realizedSui, (0.03 - 0.01) * 10, 1e-9)
	assert.equal(r.openBase, 10)
	near(r.unrealizedSui, (0.03 - 0.02) * 10)
})

test('a partial fill matches only the quantity it filled', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: true, price: 0.0196, quantity: 100 },
			{ isBid: false, price: 0.0198, quantity: 30 },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.0196,
	})
	assert.equal(r.matchedBase, 30)
	near(r.realizedSui, (0.0198 - 0.0196) * 30)
	assert.equal(r.openBase, 70)
})

test('a sell ahead of its buy is a short, matched by the next buy', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: false, price: 0.0198, quantity: 50 },
			{ isBid: true, price: 0.0196, quantity: 50 },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.0197,
	})
	assert.equal(r.matchedBase, 50)
	near(r.realizedSui, (0.0198 - 0.0196) * 50)
	assert.equal(r.openBase, 0)
})

test('a fee in SUI comes off realized spread; a fee in DEEP is reported, not converted', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: true, price: 0.0196, quantity: 100, makerFee: 0.0005, makerFeeIsDeep: false },
			{ isBid: false, price: 0.0198, quantity: 100, makerFee: 0.25, makerFeeIsDeep: true },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.0197,
	})
	near(r.grossRealizedSui, 0.02)
	near(r.feeSui, 0.0005)
	near(r.feeDeep, 0.25)
	near(r.realizedSui, 0.02 - 0.0005)
	// The DEEP fee is NOT silently priced into the ratio.
	assert.notEqual(r.feeDeep, 0)
})

test('the two sides are counted separately, which is what a both-sides fill count needs', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: true, price: 0.0196, quantity: 100 },
			{ isBid: false, price: 0.0198, quantity: 100 },
			{ isBid: true, price: 0.0195, quantity: 100 },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.0196,
	})
	assert.equal(r.buyFills, 2)
	assert.equal(r.sellFills, 1)
})

test('fees and roles flow from the parser shape into the ledger: taker counted, self skipped, assets kept apart', () => {
	const r = realizedSpread({
		fills: [
			{ isBid: true, price: 0.0196, quantity: 100, role: 'maker', fee: 0.001, feeAsset: 'quote' },
			{ isBid: false, price: 0.0198, quantity: 100, role: 'taker', fee: 0.5, feeAsset: 'base' },
			{ isBid: true, price: 0.02, quantity: 50, role: 'self', fee: 0.2, feeAsset: 'DEEP' },
		],
		openingBase: 0,
		openingBasis: 0,
		closingMid: 0.0197,
	})
	near(r.grossRealizedSui, 0.02)
	near(r.feeSui, 0.001)
	near(r.feeBase, 0.5)
	near(r.feeDeep, 0.2)
	assert.equal(r.takerFills, 1)
	assert.equal(r.selfFills, 1)
	assert.equal(r.matchedBase, 100)
	assert.equal(r.openBase, 0)
})

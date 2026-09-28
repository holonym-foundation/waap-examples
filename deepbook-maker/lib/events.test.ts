import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	findCreatedBalanceManagerId,
	parseOrderCanceled,
	parseOrderFilled,
	parseOrderPlaced,
	priceToHuman,
	type RpcTransactionBlock,
} from './events.ts'

/**
 * Every fixture is a REAL mainnet transaction, fetched on 2026-09-14 from
 * https://sui-rpc.publicnode.com with
 * `sui_getTransactionBlock(digest, { showEvents: true, showObjectChanges: true })`
 * and saved verbatim (the JSON-RPC `result` object) under `lib/fixtures/`.
 * Nothing here is hand-written.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(digest: string): RpcTransactionBlock {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES, `tx-${digest}.json`), 'utf8')) as RpcTransactionBlock
}

// --- the transactions -------------------------------------------------------

/**
 * A two-sided requote by the maker this recipe was pointed at:
 * BalanceManager 0x344c2734…d27d, owner 0xcde6dbe0…0e04. One transaction, one bid and
 * one ask, on the NS/USDC pool 0x0c0fdd40…c060. Exactly the shape `agent.ts` builds.
 */
const REQUOTE = 'EiWShmMjLDeiaveYodNP2ZLT3MCYQfUBZTMcYFQXjDcD'
/** A cancel by the same manager on the same pool. */
const CANCEL = '2DEcMC3NrSbC6vkyjjGcxp6i2qc2bPXLLWDmt8Phq7Rf'
/** A fill on DEEP/SUI where 0x344c2734…d27d was the resting maker. */
const FILL = '6eQtWxBR4dpyyhewZxRss7XZe38S5ryUgJyKjERU8sdh'
/** A transaction that creates a BalanceManager — and a TradeCap beside it. */
const CREATE = '8xMfiqw7HR9drnvVc8dKkN3jgW43PLVCJWeksLRip6GC'

const MAKER_MANAGER = '0x344c2734b1d211bd15212bfb7847c66a3b18803f3f5ab00f5ff6f87b6fe6d27d'
const NS_USDC_POOL = '0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060'
const DEEP_SUI_POOL = '0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22'

// FLOAT_SCALAR = 1e9 (dist/utils/config.mjs:6). NS = 1e6, USDC = 1e6,
// DEEP = 1e6, SUI = 1e9 (dist/utils/constants.mjs:81, :89, :97, :162).
const NS_USDC = { floatScalar: 1e9, baseScalar: 1e6, quoteScalar: 1e6 }
const DEEP_SUI = { floatScalar: 1e9, baseScalar: 1e6, quoteScalar: 1e9 }

/** Prices are floats after scaling; compare within a fraction of one tick. */
function near(actual: number, expected: number, eps = 1e-9): void {
	assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`)
}

// --- tests ------------------------------------------------------------------

test('OrderPlaced: real u128 order ids, sides, prices and quantities off a live requote', () => {
	const placed = parseOrderPlaced(fixture(REQUOTE), { ...NS_USDC, poolId: NS_USDC_POOL, balanceManagerId: MAKER_MANAGER })

	assert.equal(placed.length, 2)

	const ask = placed.find((o) => !o.isBid)!
	const bid = placed.find((o) => o.isBid)!

	// The ids the chain issued. These are what `cancelOrder` will take — decimal u128,
	// nothing like the `t1-bid-0` placeholders a dry run invents.
	assert.equal(ask.orderId, '170141183460673621656024005547809652752')
	assert.equal(bid.orderId, '202729735816812045949174204')
	assert.ok(BigInt(ask.orderId) < 1n << 128n)
	assert.ok(BigInt(bid.orderId) < 1n << 128n)

	// on-chain 11080000 ÷ (1e9 × 1e6 ÷ 1e6) = 0.01108 USDC per NS
	near(ask.price, 0.01108)
	near(bid.price, 0.01099)
	// on-chain placed_quantity ÷ 1e6 (NS scalar)
	near(ask.quantity, 32332)
	near(bid.quantity, 109878.4)

	// The ask sits above the bid, which is the whole point of a two-sided quote.
	assert.ok(ask.price > bid.price)

	// Nothing simulated: every one of these came back from the chain.
	assert.deepEqual(
		placed.map((o) => o.simulated),
		[false, false],
	)
	assert.equal(ask.balanceManagerId, MAKER_MANAGER)
	assert.equal(ask.poolId, NS_USDC_POOL)
})

test('OrderPlaced: the pool and manager filters exclude someone else’s orders', () => {
	const other = '0x0000000000000000000000000000000000000000000000000000000000000001'
	assert.deepEqual(parseOrderPlaced(fixture(REQUOTE), { ...NS_USDC, balanceManagerId: other }), [])
	assert.deepEqual(parseOrderPlaced(fixture(REQUOTE), { ...NS_USDC, poolId: DEEP_SUI_POOL }), [])
	// Unfiltered, both orders come back.
	assert.equal(parseOrderPlaced(fixture(REQUOTE), NS_USDC).length, 2)
})

test('OrderCanceled: the id to drop out of state.resting', () => {
	const canceled = parseOrderCanceled(fixture(CANCEL), { ...NS_USDC, balanceManagerId: MAKER_MANAGER })

	assert.equal(canceled.length, 1)
	assert.equal(canceled[0].orderId, '202914203257549141465334165')
	assert.equal(canceled[0].isBid, true)
	near(canceled[0].price, 0.011)
	near(canceled[0].quantity, 72598)
})

test('OrderFilled: side is the maker’s, not the taker’s, and the two legs agree', () => {
	const fills = parseOrderFilled(fixture(FILL), { ...DEEP_SUI, poolId: DEEP_SUI_POOL, balanceManagerId: MAKER_MANAGER })

	assert.equal(fills.length, 1)
	const f = fills[0]
	assert.equal(f.makerOrderId, '170141183846190650312954028006466277026')
	// The event says taker_is_bid: true — the taker bought, so our resting order sold.
	assert.equal(f.isBid, false)
	// on-chain 20910000000 ÷ (1e9 × 1e9 ÷ 1e6) = 0.02091 SUI per DEEP
	near(f.price, 0.02091)
	near(f.quantity, 540) // 540000000 ÷ 1e6 DEEP
	near(f.quoteQuantity, 11.2914) // 11291400000 ÷ 1e9 SUI
	// quantity × price is the quote leg — the scalars are right or this fails.
	near(f.quantity * f.price, f.quoteQuantity, 1e-6)
	assert.equal(f.makerBalanceManagerId, MAKER_MANAGER)
})

test('OrderFilled: a transaction with no fill for us yields no fill lines', () => {
	assert.deepEqual(parseOrderFilled(fixture(REQUOTE), { ...NS_USDC, balanceManagerId: MAKER_MANAGER }), [])
	// The fill transaction has a fill, but not for a different manager.
	const other = '0x0000000000000000000000000000000000000000000000000000000000000001'
	assert.deepEqual(parseOrderFilled(fixture(FILL), { ...DEEP_SUI, balanceManagerId: other }), [])
})

test('createAndShareBalanceManager: the created BalanceManager, not the TradeCap beside it', () => {
	const tx = fixture(CREATE)
	// Guard the fixture itself: this transaction really does create both objects.
	const createdTypes = (tx.objectChanges ?? [])
		.filter((c) => c?.type === 'created')
		.map((c) => String(c.objectType))
	assert.ok(createdTypes.some((t) => t.endsWith('::balance_manager::BalanceManager')))
	assert.ok(createdTypes.some((t) => t.endsWith('::balance_manager::TradeCap')))

	assert.equal(
		findCreatedBalanceManagerId(tx),
		'0xb25bb9bdb44ded1684e547b21327a2ac66452aa239410390c75f646831eb0514',
	)
	// A requote creates no manager.
	assert.equal(findCreatedBalanceManagerId(fixture(REQUOTE)), undefined)
	assert.equal(findCreatedBalanceManagerId(null), undefined)
})

test('price scaling is the documented inverse of the SDK’s convertPrice', () => {
	// convertPrice(value, floatScalar, quoteScalar, baseScalar)
	//   = value × floatScalar × quoteScalar ÷ baseScalar
	// (node_modules/@mysten/deepbook-v3/dist/utils/conversion.mjs:13)
	const human = 0.02136
	const onChain = Math.round((human * DEEP_SUI.floatScalar * DEEP_SUI.quoteScalar) / DEEP_SUI.baseScalar)
	near(priceToHuman(onChain, DEEP_SUI), human, 1e-12)
})

// --- roles and fees (28 Sep review, items 4-5) --------------------------------
//
// SYNTHETIC: the real DEEP/SUI fill carries zero fees and our manager only as maker. These
// cases edit a copy of that real event to put a fee on it and to put our manager on the
// taker side, so the direction and fee paths are exercised. They are labelled synthetic
// because no such fill of ours exists on chain.

function withFields(tx: RpcTransactionBlock, patch: Record<string, unknown>): RpcTransactionBlock {
	return {
		...tx,
		events: (tx.events ?? []).map((e) =>
			e.type.endsWith('::order_info::OrderFilled') ? { ...e, parsedJson: { ...(e.parsedJson as object), ...patch } } : e,
		),
	}
}

test('SYNTHETIC maker fill: role maker, fee carried with its scale and asset (DEEP)', () => {
	const tx = withFields(fixture(FILL), { maker_fee: '250000', maker_fee_is_deep: true })
	const [f] = parseOrderFilled(tx, { ...DEEP_SUI, poolId: DEEP_SUI_POOL, balanceManagerId: MAKER_MANAGER })
	assert.equal(f.role, 'maker')
	assert.equal(f.isBid, false)
	assert.equal(f.fee, 0.25) // 250000 ÷ 1e6 DEEP
	assert.equal(f.feeAsset, 'DEEP')
})

test('SYNTHETIC maker fill paid in the input token: an ask pays in base, a bid in quote', () => {
	const ask = parseOrderFilled(withFields(fixture(FILL), { maker_fee: '3000000', maker_fee_is_deep: false }), { ...DEEP_SUI, balanceManagerId: MAKER_MANAGER })[0]
	assert.equal(ask.feeAsset, 'base')
	assert.equal(ask.fee, 3) // 3e6 ÷ DEEP 1e6
	const bid = parseOrderFilled(withFields(fixture(FILL), { maker_fee: '3000000', maker_fee_is_deep: false, taker_is_bid: false }), { ...DEEP_SUI, balanceManagerId: MAKER_MANAGER })[0]
	assert.equal(bid.isBid, true)
	assert.equal(bid.feeAsset, 'quote')
	assert.equal(bid.fee, 0.003) // 3e6 ÷ SUI 1e9
})

test('SYNTHETIC taker fill: our side IS the taker’s side, and the taker fee is ours', () => {
	const ours = '0x00000000000000000000000000000000000000000000000000000000000000aa'
	const tx = withFields(fixture(FILL), { taker_balance_manager_id: ours, taker_fee: '1000000000', taker_fee_is_deep: false, taker_order_id: '42' })
	const fills = parseOrderFilled(tx, { ...DEEP_SUI, balanceManagerId: ours })
	assert.equal(fills.length, 1)
	const f = fills[0]
	assert.equal(f.role, 'taker')
	// taker_is_bid: true in the fixture — as the taker, WE bought.
	assert.equal(f.isBid, true)
	assert.equal(f.ownOrderId, '42')
	assert.equal(f.fee, 1) // 1e9 ÷ SUI 1e9, a bid pays in quote
	assert.equal(f.feeAsset, 'quote')
})

test('SYNTHETIC self-match: our manager on both sides is flagged, not invented into a one-sided trade', () => {
	const tx = withFields(fixture(FILL), { taker_balance_manager_id: MAKER_MANAGER })
	const [f] = parseOrderFilled(tx, { ...DEEP_SUI, balanceManagerId: MAKER_MANAGER })
	assert.equal(f.role, 'self')
})

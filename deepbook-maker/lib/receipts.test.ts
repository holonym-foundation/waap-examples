import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseGasUsed, totalGas, type RpcReceipt } from './receipts.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * REAL mainnet receipts for the five transactions this recipe actually submitted on
 * 2026-09-15, fetched 2026-09-24 with
 * `sui_getTransactionBlock(digest, { showEffects: true })` and saved verbatim.
 *
 * This is the evidence for the claim "gas is retrievable and retained": the loop never
 * asked for effects, so no run log has ever carried `gasUsed` — but the chain has it,
 * for every digest the loop ever produced.
 */
const RECEIPTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'receipts-live-5tick.json'), 'utf8')) as Record<string, RpcReceipt>

test('gasUsed is retrievable for every digest this recipe submitted', () => {
	const keys = ['create_balance_manager', 'deposit', 'requote-place', 'requote-cancel', 'requote-place2']
	for (const k of keys) {
		const gas = parseGasUsed(RECEIPTS[k])
		assert.ok(gas, `${k} has effects`)
		assert.equal(gas.status, 'success')
		assert.ok(gas.computationMist > 0, `${k} has a computation cost`)
	}
})

test('net is computation + storage − rebate, to the mist', () => {
	const gas = parseGasUsed(RECEIPTS['requote-place'])!
	assert.equal(gas.computationMist, 127000)
	assert.equal(gas.storageMist, 71668000)
	assert.equal(gas.rebateMist, 66715308)
	assert.equal(Number(gas.netSui.toFixed(9)), 0.005079692)
})

test('gross is computation + storage, and is an order of magnitude above net', () => {
	const gas = parseGasUsed(RECEIPTS['requote-place'])!
	assert.equal(Number(gas.grossSui.toFixed(9)), 0.071795)
	assert.ok(gas.grossSui > gas.netSui * 10, 'storage dominates and is mostly rebated')
})

test('a cancel can be net NEGATIVE — it frees storage', () => {
	// 4gmjUNba… cancelled one order and settled. The rebate exceeded the cost, so the
	// transaction returned SUI. A budget built as `ticks × one positive sample` cannot
	// represent this, which is why the budget is built per shape.
	const gas = parseGasUsed(RECEIPTS['requote-cancel'])!
	assert.ok(gas.netSui < 0, `expected a refund, got ${gas.netSui}`)
	assert.equal(Number(gas.netSui.toFixed(9)), -0.0001772)
})

test('the three requote costs are not one number', () => {
	const requotes = [RECEIPTS['requote-place'], RECEIPTS['requote-cancel'], RECEIPTS['requote-place2']].map((r) => parseGasUsed(r)!)
	const t = totalGas(requotes)
	assert.equal(t.count, 3)
	assert.equal(t.failed, 0)
	// The spread a single-sample estimate hides: min is negative, max is 29× the mean.
	assert.ok(t.minNetSui < 0)
	assert.ok(t.maxNetSui > 0.005)
	assert.ok(t.meanNetSui > 0.002 && t.meanNetSui < 0.0023, `mean was ${t.meanNetSui}`)
})

test('a receipt with no effects is a reported gap, not a zero', () => {
	assert.equal(parseGasUsed(null), null)
	assert.equal(parseGasUsed({ digest: 'x' }), null)
	assert.equal(parseGasUsed({ digest: 'x', effects: { status: { status: 'success' } } }), null)
})

test('a FAILED transaction still reports the gas it burned', () => {
	const failed: RpcReceipt = {
		digest: 'failed',
		effects: {
			status: { status: 'failure', error: 'InsufficientCoinBalance in command 0' },
			gasUsed: { computationCost: '1000000', storageCost: '0', storageRebate: '0', nonRefundableStorageFee: '0' },
		},
	}
	const gas = parseGasUsed(failed)!
	assert.equal(gas.status, 'failure')
	assert.equal(gas.error, 'InsufficientCoinBalance in command 0')
	assert.equal(gas.netSui, 0.001)
	assert.equal(totalGas([gas]).failed, 1)
})

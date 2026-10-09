/**
 * What the recipe actually builds. No network: commands are recorded on the Transaction
 * and inspected; nothing is resolved, built or sent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DeepBookClient } from '@mysten/deepbook-v3'
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'

import { addCleanup, addPlaceOrder, moveCallNames } from './ptb.ts'

const OWNER = '0x' + '11'.repeat(32)
const MANAGER = '0x' + '22'.repeat(32)
const db = new DeepBookClient({
	client: new SuiJsonRpcClient({ url: 'http://127.0.0.1:1', network: 'mainnet' }),
	address: OWNER,
	network: 'mainnet',
	balanceManagers: { MAKER: { address: MANAGER } },
})

function pureArgs(tx: Transaction, fn: string): Uint8Array[] {
	const data = tx.getData()
	const call = data.commands.find((c) => c.$kind === 'MoveCall' && c.MoveCall.function === fn)
	assert.ok(call && call.$kind === 'MoveCall', `${fn} not found`)
	return call.MoveCall.arguments.map((a) => {
		if (a.$kind !== 'Input') return new Uint8Array()
		const input = data.inputs[a.Input]
		return input.$kind === 'Pure' ? Uint8Array.from(Buffer.from(input.Pure.bytes, 'base64')) : new Uint8Array()
	})
}

test('placeLimitOrder is post-only, cancels a self-match, carries a finite ms expiry and explicit payWithDeep', () => {
	const tx = new Transaction()
	const exp = 1_790_000_900_000
	addPlaceOrder(tx, db, { poolKey: 'DEEP_SUI', managerKey: 'MAKER', clientOrderId: '1790000000000001', price: 0.0191, quantity: 17, isBid: false, expirationMs: exp, payWithDeep: true })
	// Arguments of pool::place_limit_order, in order:
	// self, balance_manager, trade_proof, client_order_id, order_type, self_matching_option,
	// price, quantity, is_bid, pay_with_deep, expire_timestamp, clock
	const args = pureArgs(tx, 'place_limit_order')
	assert.equal(bcs.u64().parse(args[3]), '1790000000000001')
	assert.equal(bcs.u8().parse(args[4]), 3, 'order_type must be POST_ONLY (3), not NO_RESTRICTION (0)')
	assert.equal(bcs.u8().parse(args[5]), 1, 'self_matching_option must be CANCEL_TAKER (1), not SELF_MATCHING_ALLOWED (0)')
	assert.equal(bcs.u64().parse(args[6]), '19100000000') // 0.0191 × float 1e9 × SUI 1e9 ÷ DEEP 1e6
	assert.equal(bcs.u64().parse(args[7]), '17000000') // 17 DEEP × 1e6
	assert.equal(bcs.bool().parse(args[8]), false)
	assert.equal(bcs.bool().parse(args[9]), true)
	assert.equal(bcs.u64().parse(args[10]), String(exp), 'expiry is the ms timestamp we set, not MAX_TIMESTAMP')
})

test('an invalid expiry is refused before anything is built', () => {
	for (const bad of [0, -1, Number.NaN, 1.5]) {
		assert.throws(() => addPlaceOrder(new Transaction(), db, { poolKey: 'DEEP_SUI', managerKey: 'MAKER', clientOrderId: '1', price: 0.02, quantity: 10, isBid: true, expirationMs: bad, payWithDeep: true }))
	}
})

test('cleanup is cancel-all → withdraw-settled → withdraw every coin, even with nothing left to cancel', () => {
	const tx = new Transaction()
	addCleanup(tx, db, { poolKey: 'DEEP_SUI', managerKey: 'MAKER', coins: ['DEEP', 'SUI', 'DEEP'], recipient: OWNER })
	const calls = moveCallNames(tx).filter((n) => !n.endsWith('generate_proof_as_owner'))
	assert.equal(calls[0], 'pool::cancel_all_orders')
	assert.equal(calls[1], 'pool::withdraw_settled_amounts')
	assert.equal(calls.filter((c) => c === 'balance_manager::withdraw_all').length, 2, 'DEEP and SUI, deduplicated')
})

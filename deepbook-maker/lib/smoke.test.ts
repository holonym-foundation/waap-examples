import test from 'node:test'
import assert from 'node:assert/strict'

import { gradeSmoke, type LogLine, type SmokeInput, type SmokeReceipt } from './smoke.ts'

/**
 * Fixtures for the smoke grade. The clean fixture is a 65-minute run: a deposit, three
 * requotes (the first places a real bid), a signal shutdown and a stop. Each test breaks
 * exactly one thing.
 */

const T0 = Date.parse('2026-09-28T04:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const BID_ID = '368934881492637776393680692015'

function cleanLines(): LogLine[] {
	return [
		{ ts: at(-3), message: 'tx_submitted', kind: 'deposit', digest: 'DEP' },
		{ ts: at(0), message: 'agent_start', dryRun: false, pollMs: 60000, orderSize: 20, spreadBps: 20, requoteToleranceBps: 50, maxTicks: 65 },
		{ ts: at(1), message: 'tx_submitted', tick: 1, kind: 'requote', digest: 'R1' },
		{ ts: at(1.1), message: 'orders_confirmed', tick: 1, digest: 'R1', placed: [{ orderId: BID_ID, side: 'bid', price: 0.02, quantity: 20 }] },
		{ ts: at(10), message: 'tx_submitted', tick: 10, kind: 'requote', digest: 'R2' },
		{ ts: at(30), message: 'tx_submitted', tick: 30, kind: 'requote', digest: 'R3' },
		{ ts: at(65), message: 'shutdown', reason: 'max_ticks', ticks: 65, sendTxCalls: 3, sendTxRefused: 0 },
		{ ts: at(70), message: 'tx_submitted', kind: 'stop', digest: 'STOP' },
		{ ts: at(70), message: 'stop_done', digest: 'STOP' },
	]
}

const ok = (digest: string): SmokeReceipt => ({ digest, status: 'success', netSui: 0.001, budgetMist: 1_900_000 })
const insufficientGas = (digest: string): SmokeReceipt => ({
	digest,
	status: 'failure',
	error: 'InsufficientGas',
	netSui: 0.000179,
	budgetMist: 1_901_964,
})

function clean(): SmokeInput {
	return {
		lines: cleanLines(),
		receipts: { DEP: ok('DEP'), R1: ok('R1'), R2: ok('R2'), R3: ok('R3'), STOP: ok('STOP') },
		afterStop: { stopDigest: 'STOP', openOrders: [], managerBase: 0, managerQuote: 0, pidFilePresent: false },
		codeSetsGasBudget: false,
	}
}

test('the clean run is a PASS with no exceptions', () => {
	const g = gradeSmoke(clean())
	assert.deepEqual(g.failures, [])
	assert.equal(g.verdict, 'PASS')
	assert.equal(g.exceptions.length, 0)
})

test('a WaaP-budgeted InsufficientGas requote followed by a success is a DISCLOSED EXCEPTION, not a PASS', () => {
	const input = clean()
	input.receipts.R2 = insufficientGas('R2')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'PASS_WITH_DISCLOSED_EXCEPTION')
	assert.equal(g.exceptions.length, 1)
	assert.equal(g.exceptions[0].digest, 'R2')
	assert.equal(g.exceptions[0].recoveredBy, 'R3')
	assert.equal(g.exceptions[0].netSui, 0.000179, 'the fee is recorded')
})

test('one failed receipt with any other error FAILS the run', () => {
	const input = clean()
	input.receipts.R2 = { digest: 'R2', status: 'failure', error: 'MoveAbort(place_limit_order, 3)', netSui: 0.0002 }
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.match(g.failures.join('\n'), /not InsufficientGas/)
})

test('InsufficientGas with no later successful requote FAILS', () => {
	const input = clean()
	input.receipts.R3 = insufficientGas('R3')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.match(g.failures.join('\n'), /no successful requote followed/)
})

test('InsufficientGas FAILS when the shipped code sets its own gas budget', () => {
	const input = clean()
	input.receipts.R2 = insufficientGas('R2')
	input.codeSetsGasBudget = true
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('a failed stop, deposit or create is never exempt', () => {
	for (const d of ['STOP', 'DEP']) {
		const input = clean()
		input.receipts[d] = insufficientGas(d)
		assert.equal(gradeSmoke(input).verdict, 'FAIL', d)
	}
})

test('a missing receipt FAILS', () => {
	const input = clean()
	delete input.receipts.R3
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.match(g.failures.join('\n'), /missing receipt for requote R3/)
})

test('under 60 minutes FAILS, and ticks do not substitute for wall clock', () => {
	const input = clean()
	input.lines = input.lines.map((l) => (l.message === 'shutdown' ? { ...l, ts: at(59), ticks: 90 } : l))
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('a tick_failed FAILS', () => {
	const input = clean()
	input.lines.splice(5, 0, { ts: at(20), message: 'tick_failed', error: 'Unexpected status code: 403' })
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('a second agent_start (a restart) FAILS', () => {
	const input = clean()
	input.lines.splice(5, 0, { ...input.lines[1], ts: at(20) })
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('an hour of successful sweeps with no real placement FAILS', () => {
	const input = clean()
	input.lines = input.lines.filter((l) => l.message !== 'orders_confirmed')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.match(g.failures.join('\n'), /placed a real order/)
})

test('a placement inside a FAILED transaction does not count as a real placement', () => {
	const input = clean()
	input.receipts.R1 = insufficientGas('R1')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.match(g.failures.join('\n'), /placed a real order/)
})

test('counters that do not reconcile FAIL', () => {
	const input = clean()
	input.lines = input.lines.map((l) => (l.message === 'shutdown' ? { ...l, sendTxCalls: 4 } : l))
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('open orders, a non-empty manager, an unreadable chain or a surviving pid file FAIL', () => {
	const cases: Array<(i: SmokeInput) => void> = [
		(i) => (i.afterStop.openOrders = [BID_ID]),
		(i) => (i.afterStop.managerQuote = 0.4),
		(i) => (i.afterStop.openOrders = undefined),
		(i) => (i.afterStop.managerBase = undefined),
		(i) => (i.afterStop.pidFilePresent = true),
		(i) => (i.afterStop.stopDigest = undefined),
	]
	for (const [n, mutate] of cases.entries()) {
		const input = clean()
		mutate(input)
		assert.equal(gradeSmoke(input).verdict, 'FAIL', `case ${n}`)
	}
})

test('missing settings on agent_start FAIL: the evidence must carry the configuration', () => {
	const input = clean()
	input.lines = input.lines.map((l) => (l.message === 'agent_start' ? { ts: l.ts, message: l.message, dryRun: false } : l))
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

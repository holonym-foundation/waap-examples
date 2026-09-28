import test from 'node:test'
import assert from 'node:assert/strict'

import { gradeSmoke, type LogLine, type SmokeInput, type SmokeReceipt } from './smoke.ts'

/**
 * Fixtures for the smoke grade. The clean fixture is one 65-minute run: three requotes
 * (the first places a real bid), a fill, quotes stopped at 65, cleanup confirmed at 66,
 * loop exit. Each test breaks exactly one thing.
 *
 * The four chronology counterexamples from the 28 Sep review
 * (`review-evidence-2026-09-28/grader-boundaries.mts`) are asserted here: under the old
 * grader they returned PASS / PASS_WITH_DISCLOSED_EXCEPTION; each must now FAIL or be
 * disclosed.
 */

const T0 = Date.parse('2026-09-28T04:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const BID_ID = '368934881492637776393680692015'
const RUN = 'run-1'
const ID = { owner: '0xowner', network: 'mainnet', poolKey: 'DEEP_SUI', poolId: '0xpool', balanceManagerId: '0xmgr' }
const zero = { openOrders: [], settled: { base: 0, quote: 0, deep: 0 }, managerBase: 0, managerQuote: 0, managerDeep: 0 }

function cleanLines(): LogLine[] {
	return [
		{ ts: at(-3), message: 'tx_submitted', kind: 'deposit', digest: 'DEP', balanceManagerId: '0xmgr' },
		{ ts: at(0), message: 'agent_start', runId: RUN, ...ID, dryRun: false, pollMs: 60000, orderSize: 20, spreadBps: 20, requoteToleranceBps: 50, maxTicks: 65 },
		{ ts: at(1), message: 'tx_submitted', runId: RUN, proc: 'loop', tick: 1, kind: 'requote', digest: 'R1' },
		{ ts: at(1.1), message: 'orders_confirmed', runId: RUN, tick: 1, digest: 'R1', placed: [{ orderId: BID_ID, side: 'bid', price: 0.02, quantity: 20 }] },
		{ ts: at(5), message: 'fill', runId: RUN, isBid: true, quantity: 20 },
		{ ts: at(10), message: 'tx_submitted', runId: RUN, proc: 'loop', tick: 10, kind: 'requote', digest: 'R2' },
		{ ts: at(30), message: 'tx_submitted', runId: RUN, proc: 'loop', tick: 30, kind: 'requote', digest: 'R3' },
		{ ts: at(65), message: 'quotes_stopped', runId: RUN, reason: 'max_ticks' },
		{ ts: at(65.1), message: 'cleanup_started', runId: RUN, ...ID },
		{ ts: at(65.2), message: 'tx_submitted', runId: RUN, proc: 'loop', kind: 'cleanup', digest: 'CLEAN' },
		{ ts: at(66), message: 'cleanup_confirmed', runId: RUN, ...ID, digest: 'CLEAN', residualsReadAt: at(65.9), residuals: zero },
		{ ts: at(66.1), message: 'process_exit', runId: RUN, proc: 'loop', sendTxCalls: 4, sendTxRefused: 0 },
	]
}

const ok = (digest: string): SmokeReceipt => ({ digest, status: 'success', netSui: 0.001, budgetMist: 1_900_000 })
const insufficientGas = (digest: string): SmokeReceipt => ({ digest, status: 'failure', error: 'InsufficientGas', netSui: 0.000179, budgetMist: 1_901_964 })

function clean(): SmokeInput {
	return {
		lines: cleanLines(),
		receipts: { DEP: ok('DEP'), R1: ok('R1'), R2: ok('R2'), R3: ok('R3'), CLEAN: ok('CLEAN') },
		finalCheck: { ...zero, lockPresent: false },
		codeSetsGasBudget: false,
	}
}

const move = (input: SmokeInput, digestOrMsg: string, min: number) => {
	input.lines = input.lines.map((l) => (l['digest'] === digestOrMsg || l.message === digestOrMsg ? { ...l, ts: at(min) } : l))
	return input
}

test('the clean run is a PASS, with utility demonstrated', () => {
	const g = gradeSmoke(clean())
	assert.deepEqual(g.failures, [])
	assert.equal(g.verdict, 'PASS')
	assert.equal(g.utility, 'DEMONSTRATED')
})

test('a WaaP-budgeted InsufficientGas requote followed by a success is a DISCLOSED EXCEPTION, not a PASS', () => {
	const input = clean()
	input.receipts.R2 = insufficientGas('R2')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'PASS_WITH_DISCLOSED_EXCEPTION')
	assert.equal(g.exceptions.length, 1)
	assert.equal(g.exceptions[0].recoveredBy, 'R3')
	assert.equal(g.disclosures.lateCleanup, null)
})

test('counterexample: recovery only AFTER quotes stopped FAILS (and the late requote itself fails)', () => {
	const input = clean()
	input.receipts.R3 = insufficientGas('R3')
	input.lines.push({ ts: at(90), message: 'tx_submitted', runId: RUN, proc: 'loop', tick: 90, kind: 'requote', digest: 'LATER' })
	input.receipts.LATER = ok('LATER')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.ok(g.failures.some((f) => f.includes('R3') && f.includes('before quoting stopped')))
	assert.ok(g.failures.some((f) => f.includes('after quotes_stopped')))
})

test('counterexample: a cleanup from BEFORE the run FAILS', () => {
	const input = move(move(clean(), 'CLEAN', -10), 'cleanup_confirmed', -10)
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.ok(g.failures.some((f) => f.includes('before the run started')))
})

test('counterexample: cleanup 83 minutes after quotes stopped is DISCLOSED as late, never a plain PASS', () => {
	const input = clean()
	input.lines = input.lines.map((l) =>
		l.message === 'cleanup_confirmed' ? { ...l, ts: at(148), residualsReadAt: at(147.9) } : l['digest'] === 'CLEAN' ? { ...l, ts: at(147) } : l,
	)
	const g = gradeSmoke(input)
	assert.deepEqual(g.failures, [])
	assert.equal(g.verdict, 'PASS_WITH_DISCLOSED_EXCEPTION')
	assert.deepEqual(g.disclosures.lateCleanup, { minutes: 83 })
	assert.equal(g.disclosures.gasExceptions, 0)
})

test('counterexample: the control of the old boundary script still PASSES', () => {
	assert.equal(gradeSmoke(clean()).verdict, 'PASS')
})

test('a cleanup on a different manager FAILS the identity check', () => {
	const input = clean()
	input.lines = input.lines.map((l) => (l.message === 'cleanup_confirmed' ? { ...l, balanceManagerId: '0xother' } : l))
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.ok(g.failures.some((f) => f.includes('balanceManagerId 0xother')))
})

test('lines from another run are ignored, so another run’s recovery cannot rescue this one', () => {
	const input = clean()
	input.receipts.R3 = insufficientGas('R3')
	input.lines.splice(8, 0, { ts: at(40), message: 'tx_submitted', runId: 'run-0', proc: 'loop', tick: 40, kind: 'requote', digest: 'OTHER' })
	input.receipts.OTHER = ok('OTHER')
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
})

test('settled balances left in the pool account FAIL even when the manager is empty', () => {
	const input = clean()
	input.finalCheck.settled = { base: 3, quote: 0, deep: 0 }
	const g = gradeSmoke(input)
	assert.equal(g.verdict, 'FAIL')
	assert.ok(g.failures.some((f) => f.includes('settled balances not swept')))
})

test('residuals read before the cleanup was submitted do not count', () => {
	const input = clean()
	input.lines = input.lines.map((l) => (l.message === 'cleanup_confirmed' ? { ...l, residualsReadAt: at(65) } : l))
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('one failed receipt with any other error FAILS the run', () => {
	const input = clean()
	input.receipts.R2 = { ...insufficientGas('R2'), error: 'MoveAbort(withdraw_with_proof)' }
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('InsufficientGas with no later successful requote FAILS', () => {
	const input = clean()
	input.receipts.R3 = insufficientGas('R3')
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('InsufficientGas FAILS when the shipped code sets its own gas budget', () => {
	const input = clean()
	input.receipts.R2 = insufficientGas('R2')
	input.codeSetsGasBudget = true
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('a failed cleanup or deposit is never exempt', () => {
	for (const d of ['CLEAN', 'DEP']) {
		const input = clean()
		input.lines[0].runId = RUN
		input.receipts[d] = insufficientGas(d)
		assert.equal(gradeSmoke(input).verdict, 'FAIL', d)
	}
})

test('a missing receipt FAILS', () => {
	const input = clean()
	delete input.receipts.R2
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('under 60 minutes of quoting FAILS', () => {
	const input = move(clean(), 'quotes_stopped', 50)
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('a tick_failed FAILS', () => {
	const input = clean()
	input.lines.splice(4, 0, { ts: at(3), message: 'tick_failed', runId: RUN })
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('a second agent_start in the same run (a restart) FAILS', () => {
	const input = clean()
	input.lines.splice(5, 0, { ...input.lines[1], ts: at(4) })
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('no real placement FAILS; no fill leaves utility INCONCLUSIVE but does not fail the lifecycle', () => {
	const noPlace = clean()
	noPlace.lines = noPlace.lines.filter((l) => l.message !== 'orders_confirmed')
	assert.equal(gradeSmoke(noPlace).verdict, 'FAIL')

	const noFill = clean()
	noFill.lines = noFill.lines.filter((l) => l.message !== 'fill')
	const g = gradeSmoke(noFill)
	assert.equal(g.verdict, 'PASS')
	assert.equal(g.utility, 'INCONCLUSIVE')
})

test('a placement inside a FAILED transaction does not count', () => {
	const input = clean()
	input.receipts.R1 = { ...insufficientGas('R1'), error: 'MoveAbort' }
	assert.ok(gradeSmoke(input).failures.some((f) => f.includes('placed a real order')))
})

test('counters that do not reconcile FAIL', () => {
	const input = clean()
	input.lines = input.lines.map((l) => (l.message === 'process_exit' ? { ...l, sendTxCalls: 7 } : l))
	assert.equal(gradeSmoke(input).verdict, 'FAIL')
})

test('open orders, a non-empty manager, an unreadable chain or a surviving lock FAIL', () => {
	const cases: Array<(i: SmokeInput) => void> = [
		(i) => (i.finalCheck.openOrders = ['1']),
		(i) => (i.finalCheck.managerBase = 17),
		(i) => (i.finalCheck.managerQuote = undefined),
		(i) => (i.finalCheck.settled = undefined),
		(i) => (i.finalCheck.lockPresent = true),
	]
	for (const c of cases) {
		const input = clean()
		c(input)
		assert.equal(gradeSmoke(input).verdict, 'FAIL')
	}
})

test('missing settings or identity on agent_start FAIL', () => {
	const input = clean()
	delete input.lines[1].spreadBps
	delete input.lines[1].poolId
	const g = gradeSmoke(input)
	assert.ok(g.failures.some((f) => f.includes('spreadBps')))
	assert.ok(g.failures.some((f) => f.includes('poolId')))
})

test('no quotes_stopped or no cleanup_confirmed FAILS', () => {
	for (const m of ['quotes_stopped', 'cleanup_confirmed']) {
		const input = clean()
		input.lines = input.lines.filter((l) => l.message !== m)
		assert.equal(gradeSmoke(input).verdict, 'FAIL', m)
	}
})

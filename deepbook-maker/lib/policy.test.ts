import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyProbeResponse } from './policy.ts'

/**
 * These patterns have NOT been exercised against a live waap-cli refusal — no refusal
 * has been observed on this account and the exact wording is not documented in this
 * workspace. What the tests below fix is the DECISION RULE, not the vocabulary: an
 * unrecognised answer must come back `unknown` and send the grader to the raw text
 * rather than be rounded up into evidence. See `lib/policy.ts`.
 */

test('an approval request is policy evidence', () => {
	const c = classifyProbeResponse('{"event":"result","status":"approval_required","channel":"telegram"}')
	assert.equal(c.outcome, 'policy_ask')
	assert.equal(c.isPolicyEvidence, true)
})

test('a spend-limit rejection is policy evidence', () => {
	const c = classifyProbeResponse('Error: transaction exceeds daily-spend-limit for this account')
	assert.equal(c.outcome, 'policy_reject')
	assert.equal(c.isPolicyEvidence, true)
})

test("Sui's own balance error is not policy evidence", () => {
	const c = classifyProbeResponse('Error: InsufficientCoinBalance in command 0')
	assert.equal(c.outcome, 'insufficient_funds')
	assert.equal(c.isPolicyEvidence, false)
})

test('the balance check is read BEFORE the policy patterns', () => {
	// If the CLI says both — "the policy would have asked, but you cannot afford it" —
	// the honest reading is that the chain decided. Grading the policy probe on the policy word in
	// that sentence would award the row to a transaction that never got evaluated.
	const c = classifyProbeResponse('daily limit check skipped: InsufficientCoinBalance in command 0')
	assert.equal(c.outcome, 'insufficient_funds')
	assert.equal(c.isPolicyEvidence, false)
})

test('a missing session is not policy evidence', () => {
	assert.equal(classifyProbeResponse('{"error":"NO_SESSION"}').outcome, 'no_session')
})

test('a signed transaction is recognised and is not a refusal', () => {
	const c = classifyProbeResponse('{"event":"result","txHash":"AbCdEf"}')
	assert.equal(c.outcome, 'signed')
	assert.equal(c.isPolicyEvidence, false)
})

test('an empty or unrecognised answer is unknown, never guessed', () => {
	for (const raw of [null, undefined, '', '   ', 'something nobody predicted']) {
		const c = classifyProbeResponse(raw)
		assert.equal(c.outcome, 'unknown')
		assert.equal(c.isPolicyEvidence, false)
		assert.equal(c.matched, null)
	}
})

test('the matched substring is reported so a grader can check the call', () => {
	const c = classifyProbeResponse('POLICY DENIED by account rules')
	assert.equal(c.matched, 'policy denied')
})

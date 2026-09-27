import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Refusal capture — the the policy probe evidence path.
 *
 * ## What was broken
 *
 * `signAndSendTx` assigned `lastSendTxStdout = stdout` AFTER `await execa(...)`. A
 * waap-cli that exits nonzero makes execa throw, so the assignment never ran and
 * `refuse-probe.ts` logged `response: null`. the policy probe is graded on that field, and a policy
 * refusal is exactly the case that exits nonzero — so the one outcome the policy probe exists to
 * record was the one outcome that recorded nothing.
 *
 * ## How this is tested
 *
 * Not by stubbing execa: by putting a REAL executable called `waap-cli` on PATH that
 * exits with the code and output this test chooses. That exercises the actual child
 * process, the actual nonzero exit and the actual error object execa throws — the
 * things the bug lived in. Nothing here touches the network, the enclave or a key, and
 * the fake never signs anything.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deepbook-waap-test-'))
const BIN = path.join(TMP, 'bin')
fs.mkdirSync(BIN, { recursive: true })

/** Install a fake `waap-cli` that prints what we say and exits how we say. */
function fakeCli(stdout: string, stderr: string, exitCode: number): void {
	const script = `#!/bin/sh\ncat <<'STDOUT_EOF'\n${stdout}\nSTDOUT_EOF\ncat <<'STDERR_EOF' >&2\n${stderr}\nSTDERR_EOF\nexit ${exitCode}\n`
	const p = path.join(BIN, 'waap-cli')
	fs.writeFileSync(p, script)
	fs.chmodSync(p, 0o755)
}

process.env.AGENT_DRY_RUN = '0' // the guard must be OFF or nothing is sent at all
process.env.AGENT_LOG_FILE = path.join(TMP, 'test.jsonl')
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`

const waap = await import('./waap.ts')

test('a policy REFUSAL that exits nonzero keeps its evidence', async () => {
	const refusal = '{"event":"result","status":"rejected","reason":"daily-spend-limit exceeded","approvalRequired":true}'
	fakeCli(refusal, 'waap-cli: transaction rejected by account policy', 1)

	await assert.rejects(() => waap.signAndSendTx('AAAA', 'refuse_probe'), 'the error still propagates unchanged')

	const captured = waap.getLastSendTxStdout()
	assert.ok(captured, 'stdout survived the nonzero exit — this is the line that used to be null')
	assert.match(captured!, /daily-spend-limit exceeded/)
	assert.match(captured!, /rejected by account policy/, 'stderr is captured too')

	const result = waap.getLastSendTxResult()
	assert.equal(result?.ok, false)
	assert.equal(result?.exitCode, 1)
	assert.match(result?.stdout ?? '', /approvalRequired/)
	assert.match(result?.stderr ?? '', /rejected by account policy/)
})

test('the refusal classifies as policy evidence, not as a bare failure', async () => {
	const { classifyProbeResponse } = await import('./policy.ts')
	const c = classifyProbeResponse(waap.getLastSendTxStdout())
	assert.equal(c.isPolicyEvidence, true)
	assert.ok(c.outcome === 'policy_reject' || c.outcome === 'policy_ask', `got ${c.outcome}`)
})

test('an insufficient-balance failure is NOT graded as a policy refusal', async () => {
	// The 999 SUI probe is deliberately larger than the wallet. If the chain, not the
	// policy, is what says no, the policy probe has no evidence — and must not be awarded one.
	fakeCli('', 'Error: InsufficientCoinBalance in command 0', 1)
	await assert.rejects(() => waap.signAndSendTx('AAAA', 'refuse_probe'))

	const { classifyProbeResponse } = await import('./policy.ts')
	const c = classifyProbeResponse(waap.getLastSendTxStdout())
	assert.equal(c.isPolicyEvidence, false)
	assert.equal(c.outcome, 'insufficient_funds')
})

test('a nonzero exit with no output at all is reported, not invented', async () => {
	fakeCli('', '', 3)
	await assert.rejects(() => waap.signAndSendTx('AAAA', 'refuse_probe'))
	const result = waap.getLastSendTxResult()
	assert.equal(result?.ok, false)
	assert.equal(result?.exitCode, 3)
	// Both channels were empty, so there is nothing to show — and `null` here is honest.
	assert.equal(waap.getLastSendTxStdout(), null)
	const { classifyProbeResponse } = await import('./policy.ts')
	assert.equal(classifyProbeResponse(waap.getLastSendTxStdout()).outcome, 'unknown')
})

test('a successful send still returns the digest and records ok', async () => {
	fakeCli('{"event":"result","txHash":"AbCdEf123"}', '', 0)
	const digest = await waap.signAndSendTx('AAAA', 'requote')
	assert.equal(digest, 'AbCdEf123')
	const result = waap.getLastSendTxResult()
	assert.equal(result?.ok, true)
	assert.equal(result?.exitCode, 0)
})

test('an error event that exits 0 is a failure, never a null digest', async () => {
	// A null digest from a live send reads as "dry run" to agent.ts, which would then
	// record placeholder orders as resting. The stream decides, not the exit code.
	fakeCli('{"event":"error","code":"PREPARE_FAILED","message":"gas selection failed"}', '', 0)
	const refusedBefore = waap.getSendTxRefused()
	await assert.rejects(() => waap.signAndSendTx('AAAA', 'requote'), /PREPARE_FAILED/)
	assert.equal(waap.getSendTxRefused(), refusedBefore + 1, 'counted as refused, so calls − refused = submitted')
})

test('an exit-0 stream with no result and no digest is a failure too', async () => {
	fakeCli('{"event":"progress","step":"prepare"}', '', 0)
	await assert.rejects(() => waap.signAndSendTx('AAAA', 'requote'), /no transaction digest/)
})

test('401 and 403 rotate the RPC; a bad request does not', () => {
	assert.equal(waap.isEndpointFailure(new Error('Unexpected status code: 403')), true)
	assert.equal(waap.isEndpointFailure(new Error('Unexpected status code: 401')), true)
	assert.equal(waap.isEndpointFailure(new Error('Unexpected status code: 429')), true)
	assert.equal(waap.isEndpointFailure(new Error('InsufficientCoinBalance in command 0')), false)
})

test('the default mainnet fallbacks no longer include rpcpool', () => {
	assert.equal(waap.RPC_ENDPOINTS.some((u) => u.includes('rpcpool')), false)
})

test('every send, refused or not, counts against sendTxCalls', () => {
	// The send counter check equates `sendTxCalls` with the number of `tx_submitted` lines. A refused send
	// increments the counter and produces no `tx_submitted`, so a run containing a
	// refuse-probe breaks that equality by construction — the probe runs as its own
	// process, which is why the counters must be compared PER PROCESS.
	assert.equal(waap.getSendTxCalls(), 6)
})

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true })
})

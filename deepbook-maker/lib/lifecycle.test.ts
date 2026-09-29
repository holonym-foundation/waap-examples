/**
 * Rejecting tests for the lifecycle repairs: state, identity, lock, pending operations
 * and budgets. Each test names the failure it pins; each would pass against the old code
 * only if the defect were still there to hide it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { classifyStart, loadState, newState, saveState, StateError, type StateIdentity } from './state.ts'
import { ManagerConflictError, resolveManager } from './identity.ts'
import { acquireLock, holderStatus, LockHeldError, lockKey, readHolder, type LockEnv } from './lock.ts'
import { blocksQuoting, canFinalizePending, classifySendFailure, makeClientOrderId, normaliseOnLoad, resolveUnknown, type PendingOp } from './pending.ts'
import { addTurnover, canReserve, emptyBudget, evaluateLimits, foldReceipt, rollingTurnover, type Limits } from './budget.ts'
import { managerSetupTerminal, terminalExitCode } from './manager-setup.ts'

const ID: StateIdentity = { owner: '0xabc', network: 'mainnet', poolKey: 'DEEP_SUI', poolId: '0xpool', mode: 'live' }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-test-'))

// --- state ------------------------------------------------------------------------

test('state: a missing file is `missing`, never an implicit fresh start', () => {
	assert.deepEqual(loadState(path.join(tmp(), 'state.json'), ID), { kind: 'missing' })
})

test('state: corrupt JSON throws instead of silently starting empty (old agent.ts:185-196)', () => {
	const f = path.join(tmp(), 'state.json')
	fs.writeFileSync(f, '{"version":2,"identity":')
	assert.throws(() => loadState(f, ID), (e: unknown) => e instanceof StateError && e.code === 'corrupt')
})

test('state: an unwritable location throws instead of silently losing budgets (old agent.ts:198-202)', () => {
	const dir = tmp()
	fs.chmodSync(dir, 0o500)
	try {
		assert.throws(() => saveState(path.join(dir, 'state.json'), newState(ID)), (e: unknown) => e instanceof StateError && e.code === 'unwritable')
	} finally {
		fs.chmodSync(dir, 0o700)
	}
})

test('state: loading under another owner, network or pool throws', () => {
	const f = path.join(tmp(), 'state.json')
	saveState(f, newState(ID, '0xmgr'))
	for (const k of ['owner', 'network', 'poolKey', 'poolId', 'mode'] as const) {
		assert.throws(() => loadState(f, { ...ID, [k]: 'other' }), (e: unknown) => e instanceof StateError && e.code === 'identity', k)
	}
})

test('state: budgets, cursor, fills and pending survive a write/read round trip', () => {
	const f = path.join(tmp(), 'state.json')
	const s = newState(ID, '0xmgr')
	s.budget = foldReceipt(s.budget, { netMist: 1_500_000, status: 'success' })
	s.fills.cursor = { txDigest: 'D', eventSeq: '3' }
	s.fills.ledger = [{ key: 'D:3' } as never]
	s.pending = [{ opId: 'op', kind: 'requote', createdAtMs: 1, status: 'submitted', digest: 'X', reservedGasMist: 5, clientOrderIds: [] }]
	saveState(f, s)
	const back = loadState(f, ID)
	assert.equal(back.kind, 'loaded')
	if (back.kind !== 'loaded') return
	assert.equal(back.state.budget.gasConsumedMist, 1_500_000)
	assert.deepEqual(back.state.fills.cursor, { txDigest: 'D', eventSeq: '3' })
	assert.equal(back.state.fills.ledger.length, 1)
	assert.equal(back.state.pending[0].digest, 'X')
	// No temp file left behind.
	assert.deepEqual(fs.readdirSync(path.dirname(f)), ['state.json'])
})

test('state: v1 migrates with its manager and cursor kept and recovery required before quoting', () => {
	const f = path.join(tmp(), 'state.json')
	fs.writeFileSync(f, JSON.stringify({ balanceManagerId: '0xmgr', tick: 65, resting: [], fillCursor: { txDigest: 'C', eventSeq: '1' } }))
	const r = loadState(f, ID, 123)
	assert.equal(r.kind, 'loaded')
	if (r.kind !== 'loaded') return
	assert.equal(r.migratedFrom, 1)
	assert.equal(r.state.balanceManagerId, '0xmgr')
	assert.deepEqual(r.state.fills.cursor, { txDigest: 'C', eventSeq: '1' })
	assert.deepEqual(r.state.recovery?.requires, ['reconcile_orders', 'backfill_fills'])
})

test('state: missing state + an existing manager is refused unless adoption is explicit', () => {
	assert.equal(classifyStart({ load: { kind: 'missing' }, adopt: false }).kind, 'fresh')
	assert.equal(classifyStart({ load: { kind: 'missing' }, envManagerId: '0xmgr', adopt: false }).kind, 'refuse')
	assert.deepEqual(classifyStart({ load: { kind: 'missing' }, envManagerId: '0xmgr', adopt: true }), { kind: 'adopt', managerId: '0xmgr' })
})

// --- identity -------------------------------------------------------------------------

test('identity: stale manager A in state and B in env is refused for every caller', () => {
	assert.throws(() => resolveManager({ stateId: '0xA', envId: '0xB' }), ManagerConflictError)
	assert.deepEqual(resolveManager({ stateId: '0xA', envId: '0xa' }), { id: '0xa', source: 'both' })
	assert.deepEqual(resolveManager({ stateId: '0xA' }), { id: '0xa', source: 'state' })
	assert.deepEqual(resolveManager({ envId: '0xB' }), { id: '0xb', source: 'env' })
	assert.deepEqual(resolveManager({}), { source: 'none' })
})

// --- lock -----------------------------------------------------------------------------

function env(over: Partial<LockEnv> = {}): LockEnv {
	return { host: 'h1', pid: 100, isAlive: () => true, procStart: () => 'T100', now: () => new Date(0), ...over }
}

test('lock: a second acquire on the same account/network/pool fails while the first is live', () => {
	const dir = tmp()
	const key = lockKey('0xABC', 'mainnet', 'DEEP_SUI')
	const a = acquireLock({ dir, key, purpose: 'loop', env: env() })
	assert.throws(() => acquireLock({ dir, key, purpose: 'loop', env: env({ pid: 200 }) }), (e: unknown) => e instanceof LockHeldError && e.status === 'live')
	assert.equal(a.release(), true)
	acquireLock({ dir, key, purpose: 'loop', env: env({ pid: 200 }) })
})

test('lock: the key is per account, network and pool — not per working directory', () => {
	assert.equal(lockKey('0xABC', 'mainnet', 'DEEP_SUI'), lockKey('0xabc', 'mainnet', 'DEEP_SUI'))
	assert.notEqual(lockKey('0xabc', 'mainnet', 'DEEP_SUI'), lockKey('0xabc', 'testnet', 'DEEP_SUI'))
})

test('lock: dead, reused-pid, foreign-host and unknown holders are told apart', () => {
	const h = { token: 't', pid: 100, host: 'h1', procStart: 'T100', acquiredAt: '', purpose: 'loop', key: 'k' }
	assert.equal(holderStatus(h, env()), 'live')
	assert.equal(holderStatus(h, env({ isAlive: () => false })), 'dead')
	assert.equal(holderStatus(h, env({ procStart: () => 'T999' })), 'dead') // pid reused
	assert.equal(holderStatus(h, env({ procStart: () => undefined })), 'unknown')
	assert.equal(holderStatus(h, env({ host: 'h2' })), 'foreign_host')
	assert.equal(holderStatus(undefined, env()), 'unknown')
})

test('lock: a stale lock is refused unless broken explicitly; a foreign or unknown one is never broken', () => {
	const dir = tmp()
	const key = 'k'
	acquireLock({ dir, key, purpose: 'loop', env: env() })
	const dead = env({ pid: 200, isAlive: (p) => p === 200 })
	assert.throws(() => acquireLock({ dir, key, purpose: 'stop', env: dead }), (e: unknown) => e instanceof LockHeldError && e.status === 'dead')
	const taken = acquireLock({ dir, key, purpose: 'stop', env: dead, breakStale: true })
	assert.equal(readHolder(taken.path)?.pid, 200)

	const dir2 = tmp()
	acquireLock({ dir: dir2, key, purpose: 'loop', env: env() })
	assert.throws(() => acquireLock({ dir: dir2, key, purpose: 'stop', env: env({ host: 'h2', pid: 300 }), breakStale: true }), (e: unknown) => e instanceof LockHeldError && e.status === 'foreign_host')
})

test('lock: a process releases only its own lock', () => {
	const dir = tmp()
	const old = acquireLock({ dir, key: 'k', purpose: 'loop', env: env() })
	const dead = env({ pid: 200, isAlive: (p) => p === 200 })
	const next = acquireLock({ dir, key: 'k', purpose: 'stop', env: dead, breakStale: true })
	assert.equal(old.stillOurs(), false)
	assert.equal(old.release(), false) // must not remove the new holder's lock
	assert.equal(next.stillOurs(), true)
})

// --- pending operations ---------------------------------------------------------------

const op = (over: Partial<PendingOp> = {}): PendingOp => ({ opId: 'requote-1-1', kind: 'requote', createdAtMs: 1_000_000, status: 'unknown', reservedGasMist: 5_000_000, clientOrderIds: ['111', '112'], ...over })

test('pending: an intent found on disk after a crash is unknown, and unknown blocks quoting', () => {
	const [p] = normaliseOnLoad([op({ status: 'intent' })])
	assert.equal(p.status, 'unknown')
	assert.equal(blocksQuoting([p]).length, 1)
	assert.equal(blocksQuoting([op({ status: 'submitted', digest: 'D' })]).length, 0)
})

test('pending: timeouts and unrecognised failures are unknown; only request refusals are not-submitted', () => {
	assert.equal(classifySendFailure('Command timed out after 120000 milliseconds'), 'unknown')
	assert.equal(classifySendFailure('something odd happened'), 'unknown')
	assert.equal(classifySendFailure('waap-cli error (exit 0): SUI_BUILD_REJECTED: bad'), 'not_submitted')
	assert.equal(classifySendFailure('Transaction rejected by policy'), 'not_submitted')
})

test('pending: an unknown send later found on chain by its client order id is resolved (it was filled, not absent)', () => {
	const r = resolveUnknown(op(), [{ digest: 'LANDED', timestampMs: 1_000_500, clientOrderIds: ['112'] }], true)
	assert.deepEqual(r, { resolved: true, digest: 'LANDED', evidence: 'OrderPlaced with client_order_id in requote-1-1' })
})

test('pending: with no transaction evidence the operation stays unknown — an empty book proves nothing', () => {
	assert.equal(resolveUnknown(op(), [], true).resolved, false)
	assert.equal(resolveUnknown(op(), [{ digest: 'OTHER', timestampMs: 1_000_500, clientOrderIds: ['999'] }], true).resolved, false)
	assert.equal(resolveUnknown(op({ kind: 'cleanup', clientOrderIds: [] }), [], true).resolved, false)
})

test('pending: client order ids are unique across operations and fit u64', () => {
	const a = makeClientOrderId(1_790_000_000_000, 1)
	const b = makeClientOrderId(1_790_000_000_000, 2)
	assert.notEqual(a, b)
	assert.ok(BigInt(a) < 1n << 64n)
})

// --- manager setup terminal state --------------------------------------------------

test('manager setup: MAX_TICKS=1 rejects a refused creation instead of exiting clean', () => {
	// A refused send is removed from pending because it is known not to have landed.
	const terminal = managerSetupTerminal({ dryRun: false, pending: [] })
	assert.deepEqual(terminal, {
		ok: false,
		cause: 'not_submitted',
		instruction: 'manager creation was not submitted; fix the refusal, then rerun the setup command',
	})
	assert.equal(terminalExitCode(0, terminal), 1)
})

test('manager setup: MAX_TICKS=1 rejects an unknown creation and keeps recovery state', () => {
	const create = op({ opId: 'create-1', kind: 'create_manager', clientOrderIds: [], status: 'unknown' })
	const terminal = managerSetupTerminal({ dryRun: false, pending: [create] })
	assert.equal(terminal.ok, false)
	if (!terminal.ok) assert.equal(terminal.cause, 'outcome_unknown')
	assert.equal(terminalExitCode(0, terminal), 1)
	assert.equal(canFinalizePending(create, undefined), false)
})

test('manager setup: MAX_TICKS=1 rejects submitted creation whose manager id is unreadable', () => {
	const create = op({ opId: 'create-2', kind: 'create_manager', clientOrderIds: [], status: 'submitted', digest: 'CREATE_DIGEST' })
	const terminal = managerSetupTerminal({ dryRun: false, pending: [create] })
	assert.equal(terminal.ok, false)
	if (!terminal.ok) assert.equal(terminal.cause, 'id_unreadable')
	assert.equal(terminalExitCode(0, terminal), 1)
	assert.equal(canFinalizePending(create, undefined), false, 'the digest must remain pending until its manager id is persisted')
	assert.equal(canFinalizePending(create, '0xmanager'), true)
})

// --- budgets --------------------------------------------------------------------------

const caps = { capMist: 20_000_000, cleanupAllowanceMist: 10_000_000 }

test('budget: consumed is monotonic — a rebate never subtracts, completion never resets it', () => {
	let b = emptyBudget()
	b = foldReceipt(b, { netMist: 3_000_000, status: 'success' })
	b = foldReceipt(b, { netMist: -2_000_000, status: 'success' }) // a cancel's storage rebate
	b = foldReceipt(b, { netMist: 180_000, status: 'failure' }) // InsufficientGas still costs
	assert.equal(b.gasConsumedMist, 3_180_000)
	assert.equal(b.gasNetMist, 1_180_000) // reported, never used for capacity
	assert.equal(b.failedReceipts, 1)
})

test('budget: reservations count against the cap until their receipt is folded; unknown keeps its reservation', () => {
	const b = foldReceipt(emptyBudget(), { netMist: 10_000_000, status: 'success' })
	const pending = [op({ reservedGasMist: 6_000_000 })] // unknown, reservation held
	assert.equal(canReserve(b, pending, caps, 5_000_000, 'requote'), false)
	assert.equal(canReserve(b, [], caps, 5_000_000, 'requote'), true)
	// Cleanup keeps room even when trading is exhausted.
	assert.equal(canReserve(b, pending, caps, 5_000_000, 'cleanup'), true)
})

test('budget: persisted budget survives a restart — consumed is not reset by reloading state', () => {
	const f = path.join(tmp(), 'state.json')
	const s = newState(ID, '0xmgr')
	s.budget = foldReceipt(s.budget, { netMist: 19_000_000, status: 'success' })
	saveState(f, s)
	const back = loadState(f, ID)
	if (back.kind !== 'loaded') throw new Error('not loaded')
	assert.equal(canReserve(back.state.budget, [], caps, 5_000_000, 'requote'), false)
})

test('budget: turnover counts confirmed fills once each, both sides, in a rolling window', () => {
	let b = emptyBudget()
	b = addTurnover(b, { atMs: 1000, notionalQuote: 0.4, key: 'A' })
	b = addTurnover(b, { atMs: 2000, notionalQuote: 0.4, key: 'B' })
	b = addTurnover(b, { atMs: 2000, notionalQuote: 0.4, key: 'B' }) // re-read page
	assert.equal(rollingTurnover(b, 2500, 10_000), 0.8)
	assert.equal(rollingTurnover(b, 11_500, 10_000), 0.4)
})

const limits: Limits = { gas: caps, maxDrawdownQuote: 0.05, maxTurnoverQuote: 5, turnoverWindowMs: 86_400_000, maxRunMs: 3_600_000, maxMarkAgeMs: 120_000 }

test('limits: drawdown and gas cap halt; turnover pauses; an unknown or stale mark never reads as ok', () => {
	const base = { budget: emptyBudget(), pending: [], limits, nowMs: 1_000_000, runStartMs: 900_000, startValueQuote: 1, current: { valueQuote: 1, atMs: 1_000_000 }, nextReserveMist: 5_000_000 }
	assert.deepEqual(evaluateLimits(base), { action: 'ok' })
	assert.deepEqual(evaluateLimits({ ...base, current: { valueQuote: 0.94, atMs: 1_000_000 } }), { action: 'halt', reason: 'drawdown_cap' })
	assert.deepEqual(evaluateLimits({ ...base, current: undefined }), { action: 'pause', reason: 'mark_unknown' })
	assert.deepEqual(evaluateLimits({ ...base, current: { valueQuote: 1, atMs: 0 } }), { action: 'pause', reason: 'mark_unknown' })
	assert.deepEqual(evaluateLimits({ ...base, budget: foldReceipt(emptyBudget(), { netMist: 20_000_000, status: 'success' }) }), { action: 'halt', reason: 'gas_cap' })
	assert.deepEqual(evaluateLimits({ ...base, nowMs: 4_600_000, current: { valueQuote: 1, atMs: 4_600_000 } }), { action: 'halt', reason: 'run_duration' })
	const busy = addTurnover(emptyBudget(), { atMs: 999_000, notionalQuote: 6, key: 'X' })
	assert.deepEqual(evaluateLimits({ ...base, budget: busy }), { action: 'pause', reason: 'turnover_cap' })
})

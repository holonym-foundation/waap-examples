import test from 'node:test'
import assert from 'node:assert/strict'
import { runCleanup } from './ops.ts'
import { newState } from './state.ts'
import type { Context } from './context.ts'
import type { PendingOp } from './pending.ts'

const identity = { owner: '0xabc', network: 'mainnet', poolKey: 'DEEP_SUI', poolId: '0xpool', mode: 'live' as const }
const pending = (kind: PendingOp['kind'], status: PendingOp['status']): PendingOp => ({ opId: 'earlier', kind, status, createdAtMs: 1, reservedGasMist: 6000000, clientOrderIds: [], ...(status === 'submitted' ? { digest: 'EARLIER' } : {}) })
const clean = { openOrders: [], settled: { base: 0, quote: 0, deep: 0 }, managerBase: 0, managerQuote: 0, managerDeep: 0, poolAccount: true, readAt: new Date(1000).toISOString() }

function harness(earlier: PendingOp[] = []) {
	const state = newState(identity, '0x123')
	state.runId = 'run-1'
	state.runStartedAtMs = 1
	state.startValuation = { atMs: 1, mid: 0.02, base: 25, quote: 0.5, valueQuote: 1 }
	state.budget.gasConsumedMist = 1000000
	state.pending = earlier
	const ctx = { owner: identity.owner, identity, state, save: () => {} } as Context
	let reads = 0
	const io: NonNullable<Parameters<typeof runCleanup>[2]> = {
		dryRun: false,
		// Simulate a confirmed cleanup with earlier operations still unresolved.
		reconcilePending: async () => {
			state.pending = state.pending.filter((p) => p.opId !== 'this-cleanup')
			return state.pending
		},
		readResiduals: async () => ({ ...clean, managerBase: reads++ === 0 ? 25 : 0 }),
		buildKindBytes: async () => 'UNSIGNED_TEST_BYTES',
		sendWithIntent: async () => {
			const op: PendingOp = { ...pending('cleanup', 'submitted'), opId: 'this-cleanup', digest: 'CLEANUP' }
			state.pending.push(op)
			return { status: 'submitted', digest: 'CLEANUP', op }
		},
		fetchReceipt: async (digest) => ({ digest, effects: { status: { status: 'success' }, gasUsed: { computationCost: '1000000', storageCost: '0', storageRebate: '0' } } }),
		sleep: async () => {},
		recipientBalance: async () => 1,
	}
	return { ctx, io }
}

for (const kind of ['deposit', 'requote'] as const) {
	for (const status of ['unknown', 'submitted'] as const) {
		test(`cleanup stays unsuccessful with a ${status} ${kind}, even when residuals are empty`, async (t) => {
			const log = t.mock.method(console, 'log', () => {})
			const { ctx, io } = harness([pending(kind, status)])
			const out = await runCleanup(ctx, { runId: 'run-1', proc: 'stop', reason: 'operator_stop' }, io)
			assert.equal(out.ok, false)
			assert.equal(ctx.state.runId, 'run-1')
			assert.equal(ctx.state.budget.gasConsumedMist, 1000000)
			assert.equal(ctx.state.pending.length, 1)
			const events = log.mock.calls.map((c) => JSON.parse(String(c.arguments[0])))
			assert.ok(events.some((e) => e.message === 'cleanup_failed' && e.stage === 'pending'))
			assert.ok(!events.some((e) => e.message === 'cleanup_confirmed'))
			// After recovery resolves the earlier operation, stop verifies again and closes.
			ctx.state.pending = []
			const retry = await runCleanup(ctx, { runId: 'run-1', proc: 'stop', reason: 'operator_stop' }, io)
			assert.deepEqual(retry, { ok: true, alreadyClean: true })
			assert.equal(ctx.state.runId, undefined)
			assert.equal(ctx.state.closedRuns?.length, 1)
		})
	}
}

test('a confirmed cleanup closes a run with no outstanding operations', async () => {
	const { ctx, io } = harness()
	assert.deepEqual(await runCleanup(ctx, { runId: 'run-1', proc: 'loop', reason: 'max_ticks' }, io), { ok: true, digest: 'CLEANUP' })
	assert.equal(ctx.state.runId, undefined)
	assert.equal(ctx.state.closedRuns?.[0].cleanupDigest, 'CLEANUP')
})

test('a verified cleanup can still supersede an earlier unknown cleanup and charge its reservation', async () => {
	const { ctx, io } = harness([pending('cleanup', 'unknown')])
	const out = await runCleanup(ctx, { runId: 'run-1', proc: 'stop', reason: 'operator_stop' }, io)
	assert.equal(out.ok, true)
	assert.equal(ctx.state.pending.length, 0)
	assert.equal(ctx.state.closedRuns?.[0].budget.gasConsumedMist, 7000000)
})

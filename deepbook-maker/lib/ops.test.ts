import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { reconcilePending } from './ops.ts'
import { newState, saveState, loadState, type StateIdentity } from './state.ts'
import type { Context } from './context.ts'
import { blocksQuoting, normaliseOnLoad } from './pending.ts'
import { evaluateLimits } from './budget.ts'

const identity: StateIdentity = { owner: '0xabc', network: 'mainnet', poolKey: 'DEEP_SUI', poolId: '0xpool', mode: 'live' }

function depositContext(adjustDrawdown = true): Context {
	const state = newState(identity, '0x123')
	state.runId = 'run-1'
	state.startValuation = { atMs: 1, mid: 0.02, base: 25, quote: 0.5, valueQuote: 1 }
	state.pending = [{ opId: 'deposit-1', kind: 'deposit', runId: state.runId, createdAtMs: 2, status: 'submitted', digest: 'DEPOSIT', reservedGasMist: 6_000_000, clientOrderIds: [], deposit: { base: 0, quote: 0.6, adjustDrawdown } }]
	return { owner: identity.owner, identity, state, save: () => {} } as Context
}

const receipt = (status: string) => async (digest: string) => ({ digest, effects: { status: { status }, gasUsed: { computationCost: '1200000', storageCost: '0', storageRebate: '0' } } })

test('failed deposits charge gas without creating a fictitious drawdown', async () => {
	const ctx = depositContext()
	await reconcilePending(ctx, {}, receipt('failure'))
	assert.deepEqual(ctx.state.transfers, [])
	assert.equal(ctx.state.pending.length, 0)
	assert.equal(ctx.state.budget.failedReceipts, 1)
})

test('a failed legacy pending deposit removes its submission-time transfer', async () => {
	const ctx = depositContext()
	delete ctx.state.pending[0].deposit
	ctx.state.transfers = [{ atMs: 2, base: 0, quote: 0.6, digest: 'DEPOSIT' }, { atMs: 1, base: 1, quote: 0, digest: 'OTHER' }]
	await reconcilePending(ctx, {}, receipt('failure'))
	assert.deepEqual(ctx.state.transfers.map((t) => t.digest), ['OTHER'])
})

test('a recovered deposit applies its saved amounts once and cannot hide an existing loss', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-deposit-recovery-'))
	try {
		const file = path.join(dir, 'state.json')
		const initial = depositContext()
		initial.state.pending[0].status = 'intent'
		delete initial.state.pending[0].digest
		saveState(file, initial.state)
		const loaded = loadState(file, identity)
		assert.equal(loaded.kind, 'loaded')
		if (loaded.kind !== 'loaded') return
		const state = loaded.state
		state.pending = normaliseOnLoad(state.pending)
		assert.equal(state.pending[0].status, 'unknown')
		// The operator attaches a verified digest, exactly as recover.ts does.
		Object.assign(state.pending[0], { status: 'submitted', digest: 'DEPOSIT' })
		const ctx = { ...initial, state, save: () => saveState(file, state) }
		await reconcilePending(ctx, {}, async () => null)
		assert.equal(blocksQuoting(state.pending).length, 1, 'receipt still missing: do not quote against unadjusted inventory')
		assert.equal(state.transfers?.length ?? 0, 0)
		await reconcilePending(ctx, {}, receipt('success'))
		await reconcilePending(ctx, {}, receipt('success'))
		assert.deepEqual(state.transfers, [{ atMs: 2, base: 0, quote: 0.6, digest: 'DEPOSIT' }])
		assert.equal(state.budget.receipts, 1)
		assert.equal(state.pending.length, 0)
		const persisted = loadState(file, identity)
		assert.equal(persisted.kind, 'loaded')
		if (persisted.kind === 'loaded') assert.deepEqual(persisted.state.transfers, state.transfers)
		const limit = evaluateLimits({ budget: state.budget, pending: state.pending, limits: { gas: { capMist: 1e9, cleanupAllowanceMist: 1e8 }, maxDrawdownQuote: 0.05, maxTurnoverQuote: 20, turnoverWindowMs: 86400000, maxRunMs: 0, maxMarkAgeMs: 1000 }, nowMs: 3, runStartMs: 1, startValueQuote: 1 + state.transfers![0].quote, current: { valueQuote: 1.5, atMs: 3 }, nextReserveMist: 6000000 })
		assert.deepEqual(limit, { action: 'halt', reason: 'drawdown_cap' }, 'the 0.6 deposit cannot mask a 0.1 loss')
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('a deposit before the baseline is measured does not adjust drawdown twice', async () => {
	const ctx = depositContext(false)
	await reconcilePending(ctx, {}, receipt('success'))
	assert.equal(ctx.state.transfers?.length ?? 0, 0)
})

test('a successful legacy transfer is not duplicated when its receipt is reconciled', async () => {
	const ctx = depositContext()
	ctx.state.transfers = [{ atMs: 2, base: 0, quote: 0.6, digest: 'DEPOSIT' }]
	await reconcilePending(ctx, {}, receipt('success'))
	assert.equal(ctx.state.transfers.length, 1)
})

test('failed create-manager receipt is charged and finalized so setup may retry', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-failed-create-'))
	try {
		const file = path.join(dir, 'state.json')
		const state = newState(identity)
		state.pending.push({ opId: 'create-1', kind: 'create_manager', createdAtMs: 1, status: 'submitted', digest: 'FAILED_CREATE', reservedGasMist: 6_000_000, clientOrderIds: [] })
		const ctx = { owner: identity.owner, identity, state, save: () => saveState(file, state) } as Context
		ctx.save()
		const outstanding = await reconcilePending(ctx, {}, async (digest) => {
			assert.equal(digest, 'FAILED_CREATE')
			return { digest, effects: { status: { status: 'failure', error: 'MoveAbort' }, gasUsed: { computationCost: '1200000', storageCost: '0', storageRebate: '0' } } }
		})
		assert.deepEqual(outstanding, [])
		const persisted = loadState(file, identity)
		assert.equal(persisted.kind, 'loaded')
		if (persisted.kind !== 'loaded') return
		assert.deepEqual(persisted.state.pending, [])
		assert.equal(persisted.state.balanceManagerId, undefined)
		assert.equal(persisted.state.budget.gasConsumedMist, 1_200_000)
		assert.equal(persisted.state.budget.failedReceipts, 1)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('successful create-manager receipt keeps its digest and reservation until the id is saved', async () => {
	const state = newState(identity)
	state.pending.push({ opId: 'create-2', kind: 'create_manager', createdAtMs: 1, status: 'submitted', digest: 'SUCCESS_CREATE', reservedGasMist: 6_000_000, clientOrderIds: [] })
	const ctx = { owner: identity.owner, identity, state, save: () => {} } as Context
	const outstanding = await reconcilePending(ctx, {}, async (digest) => ({
		digest,
		effects: { status: { status: 'success' }, gasUsed: { computationCost: '1200000', storageCost: '0', storageRebate: '0' } },
	}))
	assert.equal(outstanding.length, 1)
	assert.equal(outstanding[0].digest, 'SUCCESS_CREATE')
	assert.equal(state.budget.receipts, 0)
	assert.equal(state.pending[0].reservedGasMist, 6_000_000)
})

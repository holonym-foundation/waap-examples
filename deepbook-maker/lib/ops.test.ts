import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { reconcilePending } from './ops.ts'
import { newState, saveState, loadState, type StateIdentity } from './state.ts'
import type { Context } from './context.ts'

const identity: StateIdentity = { owner: '0xabc', network: 'mainnet', poolKey: 'DEEP_SUI', poolId: '0xpool', mode: 'live' }

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

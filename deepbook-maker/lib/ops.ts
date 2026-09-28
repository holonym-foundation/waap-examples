/**
 * Sending, receipts and cleanup — the I/O half of `lib/pending.ts`, `lib/budget.ts` and
 * `lib/ptb.ts`, shared by the loop and the one-shot scripts.
 */
import { Transaction } from '@mysten/sui/transactions'

import { canReserve, foldReceipt, MIST_PER_SUI, type GasCaps } from './budget.ts'
import type { Context } from './context.ts'
import { classifySendFailure, makeOpId, resolveUnknown, type PendingKind, type PendingOp } from './pending.ts'
import { addCleanup } from './ptb.ts'
import { parseGasUsed } from './receipts.ts'
import { residualFailures, type Residuals } from './smoke.ts'
import { cliErrorEvent, getLastSendTxResult, DRY_RUN, MANAGER_KEY, POOL, POOL_KEY, buildKindBytes, fetchReceipt, log, makeDeepBookClient, recentOwnerTxs, signAndSendTx, sui, withRpc } from './waap.ts'

export const GAS_CAPS: GasCaps = {
	capMist: Math.round(Number(process.env.GAS_CAP_SUI ?? '0.15') * MIST_PER_SUI),
	cleanupAllowanceMist: Math.round(Number(process.env.CLEANUP_GAS_ALLOWANCE_SUI ?? '0.05') * MIST_PER_SUI),
}
/** Reserved per send before its receipt is known. Above the largest net cost seen (0.0047). */
export const RESERVE_PER_TX_MIST = Math.round(Number(process.env.GAS_RESERVE_PER_TX_SUI ?? '0.006') * MIST_PER_SUI)

export class GasBudgetError extends Error {}

export type SendOutcome = { status: 'dry_run' } | { status: 'submitted'; digest: string; op: PendingOp } | { status: 'not_submitted'; error: string } | { status: 'unknown'; error: string; op: PendingOp }

/**
 * Persist intent → send → persist the outcome. Nothing is signed unless the intent (with
 * its reservation and client order ids) is durably on disk first.
 */
export async function sendWithIntent(ctx: Context, args: { kind: PendingKind; b64: string; clientOrderIds?: string[]; runId?: string; proc: 'loop' | 'stop' | 'deposit' }): Promise<SendOutcome> {
	if (DRY_RUN) {
		await signAndSendTx(args.b64, args.kind) // logs dry_run_skip, returns null
		return { status: 'dry_run' }
	}
	const { state } = ctx
	if (!canReserve(state.budget, state.pending, GAS_CAPS, RESERVE_PER_TX_MIST, args.kind)) {
		throw new GasBudgetError(`gas budget: consumed ${state.budget.gasConsumedMist} + reserved ${state.pending.reduce((s, p) => s + p.reservedGasMist, 0)} + ${RESERVE_PER_TX_MIST} exceeds the ${args.kind === 'cleanup' ? 'cap + cleanup allowance' : 'cap'}`)
	}
	const now = Date.now()
	const op: PendingOp = {
		opId: makeOpId(args.kind, ++state.opSeq, now),
		kind: args.kind,
		runId: args.runId,
		createdAtMs: now,
		status: 'intent',
		reservedGasMist: RESERVE_PER_TX_MIST,
		clientOrderIds: args.clientOrderIds ?? [],
	}
	state.pending.push(op)
	ctx.save()
	log('event', 'op_intent', { opId: op.opId, kind: op.kind, runId: args.runId, proc: args.proc, reservedGasMist: op.reservedGasMist, clientOrderIds: op.clientOrderIds })
	try {
		const digest = await signAndSendTx(args.b64, args.kind)
		if (!digest) throw new Error('live send returned no digest')
		op.status = 'submitted'
		op.digest = digest
		ctx.save()
		log('event', 'tx_submitted', { kind: args.kind, digest, opId: op.opId, runId: args.runId, proc: args.proc, balanceManagerId: state.balanceManagerId })
		return { status: 'submitted', digest, op }
	} catch (err) {
		// Classify from what waap-cli itself said, not execa's message: that begins with the
		// whole command line (the base64 transaction), which pushed the CLI's answer out of the
		// logged text on 28 Sep and left a refusal classified as unknown.
		const r = getLastSendTxResult()
		const cli = cliErrorEvent([r?.stdout, r?.stderr].filter(Boolean).join('\n'))
		const execaMsg = err instanceof Error ? err.message : String(err)
		const error = [cli ? `${cli.code ?? ''}: ${cli.message ?? ''}` : '', r?.stderr ?? '', r?.stdout ?? '', execaMsg.replace(/--tx '[^']*'/, "--tx '<b64>'")].filter(Boolean).join(' | ')
		if (classifySendFailure(error) === 'not_submitted') {
			state.pending = state.pending.filter((p) => p.opId !== op.opId)
			ctx.save()
			log('warn', 'send_refused', { opId: op.opId, kind: op.kind, runId: args.runId, error: error.slice(0, 300), note: 'refused before signing; reservation released' })
			return { status: 'not_submitted', error }
		}
		op.status = 'unknown'
		op.lastError = error.slice(0, 1000)
		ctx.save()
		log('error', 'send_outcome_unknown', { opId: op.opId, kind: op.kind, runId: args.runId, error: op.lastError, note: 'quoting blocked until chain evidence resolves it; nothing is resent' })
		return { status: 'unknown', error, op }
	}
}

/**
 * Settle what can be settled: fold receipts of submitted operations into the budget and
 * release their reservations; try to resolve unknown ones from our address's history.
 * Returns the operations still outstanding.
 */
export async function reconcilePending(ctx: Context, logExtra: Record<string, unknown> = {}): Promise<PendingOp[]> {
	const { state } = ctx
	for (const op of [...state.pending]) {
		if (op.status === 'unknown' && !op.digest) {
			try {
				const { txs, complete } = await recentOwnerTxs(ctx.owner, op.createdAtMs)
				const r = resolveUnknown(op, txs, complete)
				if (r.resolved) {
					op.status = 'submitted'
					op.digest = r.digest
					ctx.save()
					log('event', 'op_resolved', { opId: op.opId, digest: r.digest, evidence: r.evidence, ...logExtra })
				} else log('warn', 'op_still_unknown', { opId: op.opId, kind: op.kind, why: r.why, ...logExtra })
			} catch (err) {
				log('warn', 'op_resolve_failed', { opId: op.opId, error: String(err).slice(0, 200), ...logExtra })
			}
		}
		if (op.digest) {
			const g = parseGasUsed(await fetchReceipt(op.digest), op.digest)
			if (!g) {
				log('warn', 'tx_gas_missing', { opId: op.opId, digest: op.digest, note: 'receipt not readable yet; reservation kept', ...logExtra })
				continue
			}
			state.budget = foldReceipt(state.budget, { netMist: Math.round(g.netSui * MIST_PER_SUI), status: g.status })
			state.pending = state.pending.filter((p) => p.opId !== op.opId)
			ctx.save()
			log('event', 'tx_gas', { opId: op.opId, kind: op.kind, digest: op.digest, status: g.status, error: g.error ?? null, netSui: g.netSui, grossSui: g.grossSui, gasConsumedMist: state.budget.gasConsumedMist, gasNetMist: state.budget.gasNetMist, ...logExtra })
		}
	}
	return state.pending
}

export async function readResiduals(owner: string, managerId: string): Promise<Residuals & { readAt: string; poolAccount?: boolean }> {
	const db = makeDeepBookClient(owner, managerId)
	const r: Residuals & { poolAccount?: boolean } = {}
	try {
		// A manager that never traded on this pool has no pool account: nothing can be open
		// or settled, and `accountOpenOrders`/`account` would throw rather than say so.
		const exists = await withRpc('accountExists:residual', () => db.accountExists(POOL_KEY, MANAGER_KEY))
		r.poolAccount = exists
		if (!exists) {
			r.openOrders = []
			r.settled = { base: 0, quote: 0, deep: 0 }
		} else {
			r.openOrders = (await withRpc('accountOpenOrders:residual', () => db.accountOpenOrders(POOL_KEY, MANAGER_KEY))).map(String)
			const acct = (await withRpc('account:residual', () => db.account(POOL_KEY, MANAGER_KEY))) as { settled_balances?: { base?: number; quote?: number; deep?: number } }
			const st = acct?.settled_balances ?? {}
			r.settled = { base: Number(st.base ?? 0), quote: Number(st.quote ?? 0), deep: Number(st.deep ?? 0) }
		}
	} catch {}
	try {
		r.managerBase = (await withRpc('balance:base:residual', () => db.checkManagerBalance(MANAGER_KEY, POOL.baseCoin))).balance
		r.managerQuote = (await withRpc('balance:quote:residual', () => db.checkManagerBalance(MANAGER_KEY, POOL.quoteCoin))).balance
		r.managerDeep = POOL.baseCoin === 'DEEP' || POOL.quoteCoin === 'DEEP' ? 0 : (await withRpc('balance:deep:residual', () => db.checkManagerBalance(MANAGER_KEY, 'DEEP'))).balance
	} catch {}
	return { ...r, readAt: new Date().toISOString() }
}

export const isClean = (r: Residuals) => residualFailures('x', r).length === 0

/**
 * cancel → settle → withdraw, then verify from chain. Used by the loop on every handled
 * exit and by `stop.ts`. Writes `cleanup_started` then `cleanup_confirmed` or
 * `cleanup_failed`, under the run's id.
 */
export async function runCleanup(ctx: Context, args: { runId?: string; proc: 'loop' | 'stop'; reason: string; recipient?: string }): Promise<{ ok: boolean; digest?: string; alreadyClean?: boolean }> {
	const { state, owner } = ctx
	const managerId = state.balanceManagerId
	const idFields = { owner, network: ctx.identity.network, poolKey: ctx.identity.poolKey, poolId: ctx.identity.poolId, balanceManagerId: managerId }
	const recipient = args.recipient ?? owner
	if (!managerId) {
		log('info', 'cleanup_not_needed', { runId: args.runId, proc: args.proc, reason: 'no manager' })
		if (DRY_RUN) closeRun(ctx, args.runId)
		return { ok: true, alreadyClean: true }
	}
	log('event', 'cleanup_started', { runId: args.runId, proc: args.proc, reason: args.reason, recipient, ...idFields })

	await reconcilePending(ctx, { runId: args.runId })
	const before = await readResiduals(owner, managerId)
	// A dry run always builds the cleanup bytes, so the rehearsal exercises the real builder.
	if (isClean(before) && state.pending.length === 0 && !DRY_RUN) {
		log('event', 'cleanup_verified_clean', { runId: args.runId, proc: args.proc, residuals: before, residualsReadAt: before.readAt, ...idFields, note: 'nothing to cancel or withdraw; no transaction sent' })
		closeRun(ctx, args.runId)
		return { ok: true, alreadyClean: true }
	}

	const tx = new Transaction()
	addCleanup(tx, makeDeepBookClient(owner, managerId), { poolKey: POOL_KEY, managerKey: MANAGER_KEY, coins: [POOL.baseCoin, POOL.quoteCoin, 'DEEP'], recipient, poolAccount: before.poolAccount !== false })
	const b64 = await buildKindBytes(tx, 'cleanup', { runId: args.runId, balanceManagerId: managerId, recipient })
	if (!b64) {
		log('error', 'cleanup_failed', { runId: args.runId, proc: args.proc, stage: 'build', ...idFields, instruction: 'rerun `npm run stop`' })
		return { ok: false }
	}
	let out: SendOutcome
	try {
		out = await sendWithIntent(ctx, { kind: 'cleanup', b64, runId: args.runId, proc: args.proc })
	} catch (err) {
		log('error', 'cleanup_failed', { runId: args.runId, proc: args.proc, stage: 'reserve', error: String(err).slice(0, 300), ...idFields })
		return { ok: false }
	}
	if (out.status === 'dry_run') {
		log('info', 'cleanup_dry_run', { runId: args.runId, proc: args.proc, note: 'cancel → settle → withdraw built; nothing sent in a dry run' })
		// A dry run's state never carries a run into the next dry run (review #11).
		closeRun(ctx, args.runId)
		return { ok: true }
	}
	if (out.status !== 'submitted') {
		log('error', 'cleanup_failed', { runId: args.runId, proc: args.proc, stage: 'send', outcome: out.status, error: out.error.slice(0, 300), ...idFields, instruction: 'cleanup is idempotent: rerun `npm run stop`' })
		return { ok: false }
	}

	// The receipt, then residuals — retried, because the node can lag the digest.
	let residuals: Residuals & { readAt: string; poolAccount?: boolean } = before
	let receiptOk = false
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 2_000 * (i + 1)))
		await reconcilePending(ctx, { runId: args.runId })
		if (!receiptOk) {
			const g = parseGasUsed(await fetchReceipt(out.digest), out.digest)
			if (g && g.status !== 'success') {
				log('error', 'cleanup_failed', { runId: args.runId, proc: args.proc, stage: 'receipt', digest: out.digest, error: g.error ?? null, ...idFields, instruction: 'rerun `npm run stop`' })
				return { ok: false, digest: out.digest }
			}
			receiptOk = !!g
		}
		if (!receiptOk) continue
		residuals = await readResiduals(owner, managerId)
		if (isClean(residuals)) break
	}
	const failures = residualFailures('residuals', residuals)
	if (!failures.length && receiptOk) {
		// Earlier cleanups whose outcome was unknown are now moot: cleanup only ever withdraws
		// everything, and the chain is verified empty. Their gas is unknown, so each one's full
		// reservation is counted as consumed — never zero (review #1).
		for (const p of state.pending.filter((x) => x.kind === 'cleanup' && x.status !== 'submitted')) {
			state.budget = foldReceipt(state.budget, { netMist: p.reservedGasMist, status: 'unknown' })
			state.pending = state.pending.filter((x) => x.opId !== p.opId)
			log('event', 'op_superseded', { opId: p.opId, by: out.digest, chargedMist: p.reservedGasMist, note: 'unknown cleanup superseded by a verified cleanup; its reservation is counted as spent' })
		}
		ctx.save()
	}
	if (!receiptOk || failures.length) {
		log('error', 'cleanup_failed', { runId: args.runId, proc: args.proc, stage: 'verify', digest: out.digest, receiptOk, residuals, residualsReadAt: residuals.readAt, failures, ...idFields, instruction: 'rerun `npm run stop`; if it persists, inspect the manager on an explorer' })
		return { ok: false, digest: out.digest }
	}
	const recipientSui = await sui.getBalance({ owner: recipient }).then((b) => Number(b.totalBalance) / MIST_PER_SUI).catch(() => null)
	log('event', 'cleanup_confirmed', { runId: args.runId, proc: args.proc, digest: out.digest, residuals, residualsReadAt: residuals.readAt, recipient, recipientSuiAfter: recipientSui, ...idFields })
	closeRun(ctx, args.runId, out.digest)
	return { ok: true, digest: out.digest }
}

/** A run ends at confirmed cleanup: archive its budget and start the next run clean. */
function closeRun(ctx: Context, runId: string | undefined, digest?: string) {
	const s = ctx.state
	if (s.pending.length) {
		// An operation whose outcome is unknown could still land and place an order. The
		// chain is clean now, but the run and its budget stay open until it is resolved.
		log('warn', 'run_left_open', { runId, pending: s.pending.map((p) => ({ opId: p.opId, kind: p.kind, status: p.status })), instruction: 'rerun `npm run stop` once the pending operation is resolved (or `npm run recover`)' })
		s.resting = []
		ctx.save()
		return
	}
	s.resting = []
	if (runId || s.runId) {
		s.closedRuns = [...(s.closedRuns ?? []), { runId: runId ?? s.runId!, closedAtMs: Date.now(), budget: s.budget, cleanupDigest: digest }].slice(-20)
		s.runId = undefined
		s.startValuation = undefined
		s.runStartedAtMs = undefined
		s.fillsIncompleteSinceMs = undefined
		s.transfers = []
		s.budget = { ...s.budget, gasConsumedMist: 0, gasNetMist: 0, receipts: 0, failedReceipts: 0 }
	}
	ctx.save()
}

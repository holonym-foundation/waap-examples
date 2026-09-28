/**
 * Pending operations — intent before send, and what an unknown outcome is allowed to mean.
 *
 * Every mutating operation (manager creation, deposit, requote, cleanup) is written to
 * state BEFORE `waap-cli send-tx` runs: its kind, a unique operation id, the client
 * order ids of anything it places, and a gas reservation. Then:
 *
 *   send returns a digest       → `submitted`, digest recorded
 *   send refused before signing → removed, reservation released (nothing was sent)
 *   anything else               → `unknown`
 *   process dies mid-send       → still `intent` on disk; read back as `unknown`
 *
 * ## What resolves an unknown
 *
 * Only transaction evidence: a digest we recorded, or a transaction from our address,
 * after the intent, whose `OrderPlaced` events carry one of this operation's client
 * order ids. An empty order book or an unchanged balance is NOT evidence of
 * non-execution — the order may have filled, or the node may lag. So:
 *
 * - quoting stays blocked while any operation is `unknown`;
 * - nothing is resent blindly;
 * - the reservation is kept;
 * - cleanup is still allowed (cancel-all → settle → withdraw-all is idempotent: running
 *   it after an unknown send can only make balances more withdrawn, never double-spend);
 * - an operator can resolve by hand with a digest, or declare `not_executed` after
 *   checking an explorer (`npm run recover`). That declaration is logged as such.
 */
export type PendingKind = 'create_manager' | 'deposit' | 'requote' | 'cleanup'

export interface PendingOp {
	opId: string
	kind: PendingKind
	runId?: string
	createdAtMs: number
	status: 'intent' | 'submitted' | 'unknown'
	digest?: string
	reservedGasMist: number
	clientOrderIds: string[]
	lastError?: string
}

export function makeOpId(kind: PendingKind, seq: number, nowMs: number): string {
	return `${kind}-${nowMs}-${seq}`
}

/**
 * A u64 client order id that is unique across restarts: the clock in ms times 1000
 * plus a per-state sequence. Fits u64 until the year 2554.
 */
export function makeClientOrderId(nowMs: number, seq: number): string {
	return String(BigInt(Math.floor(nowMs)) * 1000n + BigInt(seq % 1000))
}

/** On load, an `intent` means the process died between persisting and learning the outcome. */
export function normaliseOnLoad(pending: PendingOp[]): PendingOp[] {
	return pending.map((p) => (p.status === 'intent' ? { ...p, status: 'unknown', lastError: p.lastError ?? 'process ended before the send returned' } : p))
}

/**
 * Was the failure definitely before anything was signed or submitted?
 *
 * Only failures waap-cli reports as refusals of the REQUEST: a policy rejection, no
 * session, a build the backend rejected, insufficient funds at preparation. A timeout,
 * a crash, a network error or an unrecognised message is unknown.
 */
export function classifySendFailure(message: string): 'not_submitted' | 'unknown' {
	const m = message.toLowerCase()
	if (/timed out|timeout|etimedout|econnreset|socket hang up|fetch failed|killed|sigterm|sigkill/.test(m)) return 'unknown'
	if (/sui_build_rejected|policy|rejected by|denied|not allowed|no session|not logged in|unauthori[sz]ed|insufficient (funds|balance)|no sui wallet/.test(m)) return 'not_submitted'
	return 'unknown'
}

export function blocksQuoting(pending: PendingOp[]): PendingOp[] {
	return pending.filter((p) => p.status !== 'submitted')
}

export interface OwnerTx {
	digest: string
	timestampMs: number
	/** `client_order_id` values from this tx's `OrderPlaced` events. */
	clientOrderIds: string[]
}

export type Resolution = { resolved: true; digest: string; evidence: string } | { resolved: false; why: string }

/**
 * Try to resolve an unknown operation from our address's recent transactions.
 * `candidates` must be every transaction from our address since `op.createdAtMs`
 * that the caller could read; `complete` says whether that list is known complete.
 */
export function resolveUnknown(op: PendingOp, candidates: OwnerTx[], complete: boolean): Resolution {
	if (op.digest) return { resolved: true, digest: op.digest, evidence: 'digest recorded at submission' }
	if (op.clientOrderIds.length === 0) {
		return { resolved: false, why: `${op.kind} places no order, so no client order id can identify it on chain; resolve by hand with \`npm run recover\`` }
	}
	const ids = new Set(op.clientOrderIds)
	const hit = candidates.find((t) => t.timestampMs >= op.createdAtMs - 5_000 && t.clientOrderIds.some((c) => ids.has(c)))
	if (hit) return { resolved: true, digest: hit.digest, evidence: `OrderPlaced with client_order_id in ${op.opId}` }
	return {
		resolved: false,
		why: complete
			? 'no transaction from this address carries this operation’s client order ids yet; the send may still land or may have been dropped — an empty book does not prove which'
			: 'the transaction list could not be read completely',
	}
}

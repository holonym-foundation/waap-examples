/**
 * Spending and risk budgets — pure, clock injected.
 *
 * ## Gas: consumed and reserved are two different numbers
 *
 * - `gasConsumedMist` is cumulative and monotonic. A receipt adds `max(0, net)`; a failed
 *   transaction adds what it was charged. Nothing ever subtracts from it: a storage
 *   rebate is real money back, but it does not buy more permission to spend, and
 *   completing an operation never resets what that operation consumed.
 * - A reservation lives on each pending operation (`PendingOp.reservedGasMist`). It is
 *   taken BEFORE the send and released only when that operation's receipt has been
 *   folded into `gasConsumedMist`. An operation whose outcome is unknown keeps its
 *   reservation indefinitely — not knowing what it cost is not the same as it costing zero.
 * - The cap applies to `consumed + Σ reserved`. Cleanup has its own allowance on top of
 *   the cap so that exhausting the trading budget never makes cleanup impossible.
 * - `gasNetMist` is the honest net (it can go down on a rebate). It is reported, never
 *   used to grant capacity.
 *
 * Adapted from the smart-money rotator's minimum-of-limits arithmetic
 * (aex-repo `bd4f72b`, `agent.ts.tpl:523,646`), not its model: that one summed
 * *submitted* notionals, dry runs included, and swallowed persistence errors.
 *
 * ## Turnover
 *
 * Confirmed filled notional in a rolling window. A buy and the sell that closes it both
 * count — turnover measures activity, not loss. Pending orders are not turnover until
 * they fill; an order that is cancelled or expires unfilled never counts.
 *
 * ## Drawdown
 *
 * Manager value (base × mark + quote, all of it: free, locked and settled, each once)
 * against its value when the run's budgets started. It excludes gas, so it is called
 * *inventory drawdown*, not "loss". The full-run P&L is a separate ledger (`collect-fills`).
 * Deposits and withdrawals cannot happen inside a run — they need the same process lock
 * the loop holds — so the start valuation is not moved by transfers.
 */
import type { PendingOp } from './pending.ts'

export const MIST_PER_SUI = 1_000_000_000

export interface TurnoverEntry {
	atMs: number
	notionalQuote: number
	key: string
}

export interface BudgetState {
	gasConsumedMist: number
	gasNetMist: number
	receipts: number
	failedReceipts: number
	turnover: TurnoverEntry[]
}

export function emptyBudget(): BudgetState {
	return { gasConsumedMist: 0, gasNetMist: 0, receipts: 0, failedReceipts: 0, turnover: [] }
}

export interface ReceiptCost {
	/** computation + storage − rebate, in MIST. May be negative. */
	netMist: number
	status: 'success' | 'failure' | string
}

/** Fold one receipt into the budget. Returns a new object; the input is not changed. */
export function foldReceipt(b: BudgetState, r: ReceiptCost): BudgetState {
	return {
		...b,
		gasConsumedMist: b.gasConsumedMist + Math.max(0, Math.round(r.netMist)),
		gasNetMist: b.gasNetMist + Math.round(r.netMist),
		receipts: b.receipts + 1,
		failedReceipts: b.failedReceipts + (r.status === 'success' ? 0 : 1),
	}
}

export function reservedMist(pending: PendingOp[]): number {
	return pending.reduce((s, p) => s + p.reservedGasMist, 0)
}

export interface GasCaps {
	/** Cap on consumed + reserved for everything except cleanup. */
	capMist: number
	/** Extra room only cleanup may use. */
	cleanupAllowanceMist: number
}

/** May an operation reserve `reserveMist` now? */
export function canReserve(b: BudgetState, pending: PendingOp[], caps: GasCaps, reserveMist: number, kind: string): boolean {
	const limit = caps.capMist + (kind === 'cleanup' ? caps.cleanupAllowanceMist : 0)
	return b.gasConsumedMist + reservedMist(pending) + reserveMist <= limit
}

export function addTurnover(b: BudgetState, e: TurnoverEntry): BudgetState {
	if (b.turnover.some((t) => t.key === e.key)) return b
	return { ...b, turnover: [...b.turnover, e] }
}

export function rollingTurnover(b: BudgetState, nowMs: number, windowMs: number): number {
	return b.turnover.filter((t) => t.atMs > nowMs - windowMs && t.atMs <= nowMs).reduce((s, t) => s + t.notionalQuote, 0)
}

/** Drop entries older than the window so the state file stays small. */
export function pruneTurnover(b: BudgetState, nowMs: number, windowMs: number): BudgetState {
	return { ...b, turnover: b.turnover.filter((t) => t.atMs > nowMs - windowMs) }
}

export interface Limits {
	gas: GasCaps
	/** Inventory drawdown, in quote units, at which the run stops and cleans up. */
	maxDrawdownQuote: number
	/** Turnover cap in the rolling window; exhausting it pauses new orders until it rolls. */
	maxTurnoverQuote: number
	turnoverWindowMs: number
	/** Wall-clock run limit, ms from run start. 0 = none. */
	maxRunMs: number
	/** A mark older than this is stale. */
	maxMarkAgeMs: number
}

export type LimitOutcome =
	| { action: 'ok' }
	| { action: 'pause'; reason: 'turnover_cap' | 'mark_unknown' | 'gas_reserve_unavailable' }
	| { action: 'halt'; reason: 'gas_cap' | 'drawdown_cap' | 'run_duration' }

/**
 * Terminal limits halt (cancel → settle → withdraw, then exit). Soft ones pause (cancel
 * risk-increasing orders, keep watching). An unknown or stale mark never counts as "ok".
 */
export function evaluateLimits(args: {
	budget: BudgetState
	pending: PendingOp[]
	limits: Limits
	nowMs: number
	runStartMs: number
	startValueQuote?: number
	current?: { valueQuote: number; atMs: number }
	nextReserveMist: number
}): LimitOutcome {
	const { budget, pending, limits, nowMs } = args
	if (limits.maxRunMs > 0 && nowMs - args.runStartMs >= limits.maxRunMs) return { action: 'halt', reason: 'run_duration' }
	if (budget.gasConsumedMist + reservedMist(pending) >= limits.gas.capMist) return { action: 'halt', reason: 'gas_cap' }
	if (!args.current || args.startValueQuote === undefined || nowMs - args.current.atMs > limits.maxMarkAgeMs) return { action: 'pause', reason: 'mark_unknown' }
	if (args.startValueQuote - args.current.valueQuote >= limits.maxDrawdownQuote) return { action: 'halt', reason: 'drawdown_cap' }
	if (!canReserve(budget, pending, limits.gas, args.nextReserveMist, 'requote')) {
		// Waiting helps only if a reservation is about to be released by a receipt.
		return pending.length ? { action: 'pause', reason: 'gas_reserve_unavailable' } : { action: 'halt', reason: 'gas_cap' }
	}
	if (rollingTurnover(budget, nowMs, limits.turnoverWindowMs) >= limits.maxTurnoverQuote) return { action: 'pause', reason: 'turnover_cap' }
	return { action: 'ok' }
}

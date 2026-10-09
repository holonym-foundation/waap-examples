/**
 * The PTB commands this recipe submits, in one place, so tests can check what is built.
 *
 * ## Orders are post-only, never self-match, and expire
 *
 * The SDK's `placeLimitOrder` defaults are `NO_RESTRICTION`, `SELF_MATCHING_ALLOWED` and
 * an expiry of `MAX_TIMESTAMP` (SDK 2.4.1 `transactions/deepbook.ts:47-84`). So a quote
 * that turned marketable between the book read and execution traded as TAKER, and an
 * order outlived any crash of the process that placed it. Now:
 *
 * - `POST_ONLY` (3): a quote that would cross aborts instead of taking.
 * - `CANCEL_TAKER` (1): if our own resting order is on the other side, the incoming order
 *   is cancelled rather than matched against ourselves.
 * - `expireTimestamp`: a finite ms timestamp (`expirationMs`). The pool treats an expired
 *   order as gone. Expiry bounds how long a crashed process's orders can trade; it does
 *   NOT withdraw anything — cleanup still has to run.
 *
 * ## Cleanup is cancel → settle → withdraw, always all four steps
 *
 * `cancelAllOrders` settles only through the orders it cancels. If every order had
 * already filled there is nothing to cancel, and the proceeds sit in the pool account's
 * settled balance where `withdrawAllFromManager` cannot see them — so `withdrawSettledAmounts`
 * is always called, then every coin the manager can hold is withdrawn.
 */
import type { DeepBookClient } from '@mysten/deepbook-v3'
import { OrderType, SelfMatchingOptions } from '@mysten/deepbook-v3'
import type { Transaction } from '@mysten/sui/transactions'

export const ORDER_TYPE_POST_ONLY = OrderType.POST_ONLY
export const SELF_MATCH_CANCEL_TAKER = SelfMatchingOptions.CANCEL_TAKER

export interface PlaceArgs {
	poolKey: string
	managerKey: string
	clientOrderId: string
	price: number
	quantity: number
	isBid: boolean
	expirationMs: number
	payWithDeep: boolean
}

export function addPlaceOrder(tx: Transaction, db: DeepBookClient, a: PlaceArgs): void {
	if (!Number.isSafeInteger(a.expirationMs) || a.expirationMs <= 0) throw new Error(`expirationMs must be a positive ms timestamp, got ${a.expirationMs}`)
	tx.add(
		db.deepBook.placeLimitOrder({
			poolKey: a.poolKey,
			balanceManagerKey: a.managerKey,
			clientOrderId: a.clientOrderId,
			price: a.price,
			quantity: a.quantity,
			isBid: a.isBid,
			expiration: a.expirationMs,
			orderType: ORDER_TYPE_POST_ONLY,
			selfMatchingOption: SELF_MATCH_CANCEL_TAKER,
			payWithDeep: a.payWithDeep,
		}),
	)
}

export function addCleanup(tx: Transaction, db: DeepBookClient, a: { poolKey: string; managerKey: string; coins: string[]; recipient: string; poolAccount?: boolean }): void {
	// A manager with no account on this pool has nothing to cancel or settle there, and the
	// pool calls would abort; only the manager withdrawals apply.
	if (a.poolAccount !== false) {
		tx.add(db.deepBook.cancelAllOrders(a.poolKey, a.managerKey))
		tx.add(db.deepBook.withdrawSettledAmounts(a.poolKey, a.managerKey))
	}
	for (const coin of [...new Set(a.coins)]) tx.add(db.balanceManager.withdrawAllFromManager(a.managerKey, coin, a.recipient))
}

/** The Move function names of a built transaction, in order — for tests and logs. */
export function moveCallNames(tx: Transaction): string[] {
	return tx
		.getData()
		.commands.map((c) => (c.$kind === 'MoveCall' ? `${c.MoveCall.module}::${c.MoveCall.function}` : c.$kind))
}

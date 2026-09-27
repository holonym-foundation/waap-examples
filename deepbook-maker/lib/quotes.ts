/**
 * Pure quote planner for the DeepBook maker recipe.
 *
 * No network, no SDK, no clock — everything the loop decides about *what to quote*
 * lives here so it can be tested with `node --test`. The agent does the I/O.
 *
 * Spread convention: `spreadBps` is the FULL spread (ask minus bid) in basis points.
 * Each side is quoted half of it away from mid, so `spreadBps: 20` puts the bid
 * 10 bps below mid and the ask 10 bps above.
 */

export interface RestingOrder {
	orderId: string
	isBid: boolean
	price: number
	quantity: number
}

export interface PlannedOrder {
	isBid: boolean
	price: number
	quantity: number
}

export interface PlanQuotesInput {
	/** Mid price in quote per base, e.g. SUI per DEEP. */
	mid: number
	/** Full spread (ask - bid) in basis points. */
	spreadBps: number
	/** Desired size per side, in base units (DEEP). */
	orderSize: number
	/** Free (available) base inventory in the BalanceManager. */
	baseInventory: number
	/** Free (available) quote inventory in the BalanceManager. */
	quoteInventory: number
	/**
	 * The SDK's `lockedBalance(poolKey, managerKey).base`, verbatim. Defaults to 0.
	 *
	 * **Read this before using it.** `locked_balance` is NOT "funds locked in resting
	 * orders". It is that PLUS the account's `settled_balances` — proceeds of fills that
	 * have not yet been swept back into the BalanceManager. Measured on mainnet against
	 * manager `0xdceb4ba0…dd2b5` on 2026-09-15:
	 *
	 *   bid resting  → lockedBalance {base: 0,  quote: 0.4174}, open_orders 1
	 *   bid filled   → lockedBalance {base: 20, quote: 0},      open_orders 0,
	 *                  settled_balances {base: 20}
	 *
	 * The two are not interchangeable. A cancel returns locked order funds inside the
	 * same PTB, so they may back a place in that PTB. A settled balance may not: the
	 * `withdrawSettledAmounts` that sweeps it is the LAST command in the tick's PTB, so
	 * it lands after the places, and an ask sized against it would be unbacked at the
	 * moment it is placed. It becomes spendable on the next tick, once swept.
	 *
	 * So the planner does not trust this figure as spendable. It computes what our own
	 * resting orders must have locked and uses the smaller of the two — the chain figure
	 * as a CEILING, never as the quantity. See `ownOrderLock`.
	 */
	baseLocked?: number
	/** The SDK's `lockedBalance().quote`, verbatim. Same caveat as `baseLocked` — read it. */
	quoteLocked?: number
	/** Base that must remain after the ask is placed. */
	baseFloor: number
	/** Quote that must remain after the bid is placed. */
	quoteFloor: number
	/** Orders believed to be resting on the book right now. */
	resting: RestingOrder[]
	/** How far a resting order may sit from its target before it is requoted, in bps. */
	requoteToleranceBps: number
	/** Pool tick size — every price is a multiple of this. */
	tickSize: number
	/** Pool lot size — every quantity is a multiple of this. */
	lotSize: number
	/** Pool minimum order size, in base units. */
	minSize: number
}

/**
 * Why a side was not quoted this tick. One string per skipped side, in the order
 * the sides are evaluated (bid, then ask).
 *
 *   `base_below_size`   — free base is smaller than one order, so no ask can be backed
 *   `quote_below_size`  — free quote is smaller than one bid's notional
 *   `base_below_floor`  — the ask fits, but placing it would eat into `baseFloor`
 *   `quote_below_floor` — the bid fits, but placing it would eat into `quoteFloor`
 *   `size_below_min`    — `orderSize` snapped to the lot grid is under the pool minimum
 *   `no_price`          — the target price came out at or below zero
 */
export type SkipReason =
	| 'base_below_size'
	| 'quote_below_size'
	| 'base_below_floor'
	| 'quote_below_floor'
	| 'size_below_min'
	| 'no_price'

export interface QuotePlan {
	/** Order ids to cancel this tick. */
	cancels: string[]
	/** Orders to place this tick. */
	place: PlannedOrder[]
	/** Why each unquoted side was skipped. Empty when both sides are quoted. */
	skippedSides: SkipReason[]
}

/** Decimal places implied by a step such as 0.00001 — used to scrub float dust. */
function decimalsOf(step: number): number {
	if (!Number.isFinite(step) || step <= 0) return 0
	const s = step.toString()
	if (s.includes('e') || s.includes('E')) {
		const exp = Number(s.split(/[eE]/)[1])
		return exp < 0 ? -exp : 0
	}
	const dot = s.indexOf('.')
	return dot === -1 ? 0 : s.length - dot - 1
}

const EPS = 1e-9

/** Snap a price onto the pool's tick grid. `dir` decides which way ties and dust go. */
export function roundToTick(price: number, tickSize: number, dir: 'down' | 'up' | 'nearest'): number {
	if (!(tickSize > 0)) return price
	const n = price / tickSize
	const k = dir === 'down' ? Math.floor(n + EPS) : dir === 'up' ? Math.ceil(n - EPS) : Math.round(n)
	return Number((k * tickSize).toFixed(decimalsOf(tickSize) + 2))
}

/** Snap a quantity down onto the pool's lot grid. */
export function floorToLot(quantity: number, lotSize: number): number {
	if (!(lotSize > 0)) return quantity
	const k = Math.floor(quantity / lotSize + EPS)
	return Number((k * lotSize).toFixed(decimalsOf(lotSize) + 2))
}

/**
 * What our own resting orders must have locked, per coin, derived from the resting set
 * rather than read from the chain.
 *
 * A resting bid for `q` base at `p` has `q × p` quote locked; a resting ask for `q` base
 * has `q` base locked. This is the number the planner needs, and it is the number
 * `lockedBalance` does not give: that one also carries unswept fill proceeds, which a
 * place in this tick's PTB cannot spend (see `PlanQuotesInput.baseLocked`).
 *
 * Used as `min(ownOrderLock, lockedBalance)`: the derived figure says what is ours to
 * unlock, the chain figure caps it. The cap matters when `resting` is stale — an order
 * we think is resting but that filled contributes nothing on chain, and the cap stops
 * the planner spending money that is no longer locked.
 */
export function ownOrderLock(resting: RestingOrder[]): { base: number; quote: number } {
	let base = 0
	let quote = 0
	for (const o of resting) {
		if (o.isBid) quote += o.quantity * o.price
		else base += o.quantity
	}
	return { base, quote }
}

/** Distance between two prices in basis points of the target. */
export function distanceBps(price: number, target: number): number {
	if (!(target > 0)) return Number.POSITIVE_INFINITY
	return (Math.abs(price - target) / target) * 10_000
}

/**
 * Decide what to cancel and what to place for one tick.
 *
 * Order of reasoning per side:
 *   1. target price = mid ± half the spread, snapped to the tick grid
 *   2. size = orderSize snapped down to the lot grid, then checked against minSize
 *   3. **reconcile against `resting` FIRST** — one order within tolerance is kept and
 *      the side is done: it is already quoted, so nothing is placed and nothing on it
 *      is cancelled except duplicates. Inventory is not consulted, because the funds
 *      that would make the side look empty are the ones locked inside that very order.
 *   4. only when nothing is kept: **can the side be backed at all** — an ask needs
 *      `orderSize` of base, a bid needs `orderSize × bidPrice` of quote. This is what
 *      makes a SUI-only start quote bids only: with zero DEEP there is nothing to
 *      sell, so no ask is planned.
 *   5. **inventory floor, on top of that** — the side is skipped if what remains after
 *      the order would fall below the reserve
 *
 * Steps 4 and 5 are separate on purpose. With a floor of 0 they would collapse into
 * the same test, and the log would say `base_below_floor` for a wallet that simply
 * holds no DEEP yet. The size test runs first so the reason names the real cause.
 *
 * ## Why steps 4 and 5 count locked inventory
 *
 * Available balance alone is the wrong number, and using it caused the inventory churn
 * of ticks 2-4 of the first live run: tick 2 placed a 20 DEEP bid worth 0.417 of the
 * 0.45 SUI deposit, tick 3 read 0.033 SUI available (the rest now locked in that bid),
 * concluded `quote_below_size`, and cancelled a perfectly good order — which tick 4
 * then re-placed. Step 3 is the primary fix: a resting order within tolerance is never
 * reconsidered on inventory grounds.
 *
 * Steps 4 and 5 use `available + min(ownOrderLock, lockedBalance)` for the case step 3
 * does not cover: the mid has moved beyond tolerance, so the resting order is cancelled
 * and a new one placed. The `min` is not defensive padding — `lockedBalance` also
 * reports unswept fill proceeds, which this tick's PTB cannot spend, so the chain figure
 * is a ceiling and the derived own-order lock is the quantity. See `ownOrderLock` and
 * `PlanQuotesInput.baseLocked`.
 * **Cancel and re-place in the same PTB is correct.** A PTB executes its commands in
 * order inside one transaction: `cancelLiveOrder` returns the order's locked funds to
 * the BalanceManager's available balance, and the `placeLimitOrder` that follows it in
 * the same transaction draws on that balance. So the planner may plan a place on a side
 * whose available balance is short by exactly the amount being cancelled — that is the
 * requote, and it is atomic. The agent builds cancels before places for this reason.
 *
 * The arithmetic is only safe because a place and a keep are mutually exclusive per
 * side: if anything is kept, nothing is placed (step 3), and if anything is placed,
 * every resting order on that side is in `cancels` — so every unit of `locked` counted
 * on that side really is unlocked by this very transaction. Never relax that.
 *
 * Caveat: `lockedBalance(poolKey, managerKey)` is scoped to the manager and the pool,
 * not to this agent. A second strategy resting orders on the same pool through the same
 * BalanceManager would have its locked funds counted here as if they were ours. One
 * manager, one maker.
 */
export function planQuotes(input: PlanQuotesInput): QuotePlan {
	const {
		mid,
		spreadBps,
		orderSize,
		baseInventory,
		quoteInventory,
		baseLocked = 0,
		quoteLocked = 0,
		baseFloor,
		quoteFloor,
		resting,
		requoteToleranceBps,
		tickSize,
		lotSize,
		minSize,
	} = input

	const cancels: string[] = []
	const place: PlannedOrder[] = []
	const skippedSides: SkipReason[] = []

	// What our own resting orders have locked, clamped by what the chain says is locked.
	// Derived, not trusted: `lockedBalance` also counts unswept fill proceeds, which a
	// place in this tick's PTB cannot spend. See `ownOrderLock`.
	const own = ownOrderLock(resting)
	const spendableBaseLock = Math.min(own.base, baseLocked)
	const spendableQuoteLock = Math.min(own.quote, quoteLocked)

	const quantity = floorToLot(orderSize, lotSize)
	const sizeOk = quantity >= minSize - EPS && quantity > 0

	const halfBps = spreadBps / 2
	const bidTarget = roundToTick(mid * (1 - halfBps / 10_000), tickSize, 'down')
	const askTarget = roundToTick(mid * (1 + halfBps / 10_000), tickSize, 'up')

	const sides: Array<{
		isBid: boolean
		target: number
		/** Inventory this side spends, in that side's own coin. */
		cost: number
		/**
		 * What this side can spend: available balance PLUS what is locked in our own
		 * resting orders on it, because a place only ever happens in a PTB that first
		 * cancels every one of them. See the header comment.
		 */
		held: number
		floor: number
		belowSize: SkipReason
		belowFloor: SkipReason
	}> = [
		{
			isBid: true,
			target: bidTarget,
			// A bid spends quote: size × price.
			cost: quantity * bidTarget,
			held: quoteInventory + spendableQuoteLock,
			floor: quoteFloor,
			belowSize: 'quote_below_size',
			belowFloor: 'quote_below_floor',
		},
		{
			isBid: false,
			target: askTarget,
			// An ask spends base: size.
			cost: quantity,
			held: baseInventory + spendableBaseLock,
			floor: baseFloor,
			belowSize: 'base_below_size',
			belowFloor: 'base_below_floor',
		},
	]

	for (const side of sides) {
		const onSide = resting.filter((o) => o.isBid === side.isBid)
		const quotable = sizeOk && side.target > 0

		// (3) Reconcile first. A resting order within tolerance keeps the side quoted,
		// and is never cancelled for an inventory reason — its own locked funds are
		// exactly what an available-balance test would mistake for an empty side.
		let kept = false
		const stale: string[] = []
		for (const o of onSide) {
			const inTolerance =
				quotable &&
				!kept &&
				distanceBps(o.price, side.target) <= requoteToleranceBps + EPS &&
				Math.abs(o.quantity - quantity) <= EPS
			if (inTolerance) {
				kept = true
				continue
			}
			stale.push(o.orderId)
		}

		if (kept) {
			// Already quoted. Pull duplicates on this side only; place nothing.
			cancels.push(...stale)
			continue
		}

		let reason: SkipReason | undefined
		if (!sizeOk) reason = 'size_below_min'
		else if (!(side.target > 0)) reason = 'no_price'
		// (4) Can this side be backed at all, once the stale orders unlock?
		else if (side.held < side.cost - EPS) reason = side.belowSize
		// (5) And does what remains still clear the reserve?
		else if (side.held - side.cost < side.floor - EPS) reason = side.belowFloor

		// Nothing was kept, so everything resting on this side is cancelled either way:
		// as a requote, or as a withdrawal from a side we cannot back.
		cancels.push(...stale)

		if (reason) {
			skippedSides.push(reason)
			continue
		}
		place.push({ isBid: side.isBid, price: side.target, quantity })
	}

	return { cancels, place, skippedSides }
}

/**
 * A DeepBook v3 order id packs the side and the price: bit 127 set means an ask, and
 * bits 64–126 are the price in the pool's integer units. `priceDivisor` converts those
 * units to a quote-per-base price (`floatScalar × quoteScalar / baseScalar` — 1e12 for
 * DEEP/SUI). Checked against mainnet 2026-09-25: bid `380740797699811889427920709799`
 * decodes to 0.02064, which is what its `OrderCanceled` event says.
 */
export function decodeOrderId(orderId: string, priceDivisor: number): { isBid: boolean; price: number } {
	const id = BigInt(orderId)
	const isBid = (id >> 127n) === 0n
	const raw = (id >> 64n) & ((1n << 63n) - 1n)
	return { isBid, price: Number(raw) / priceDivisor }
}

/** An order the chain says this manager has open, with what is left of it. */
export interface ChainOrder {
	orderId: string
	remaining: number
}

export interface Reconciled {
	resting: RestingOrder[]
	/** In our state, not open on chain: filled, or cancelled elsewhere. */
	dropped: string[]
	/** Open on chain, not in our state: an order a killed run left behind. */
	adopted: string[]
	/** In both, with a different remaining quantity: partly filled. */
	resized: string[]
}

/**
 * Make the planner's view of our resting orders the chain's view.
 *
 * Before this, `resting` was only ever what this process placed, corrected by the fills
 * it happened to see. On 2026-09-25 that went wrong twice over: the fill scan was hours
 * behind, so a filled bid stayed "resting", and a restart carried state forward while a
 * bid placed by the killed run sat on chain untracked. The planner priced a new bid off
 * the filled one's collateral, which was the untracked one's, and every send for 20
 * ticks aborted in `withdraw_with_proof` (seen in a live run).
 *
 * The chain wins: an order it does not list is gone, an order it lists that we do not
 * know is ours to manage, and the remaining quantity is its number, not ours.
 */
export function reconcileResting(resting: RestingOrder[], chain: ChainOrder[], priceDivisor: number): Reconciled {
	const ours = new Map(resting.map((o) => [o.orderId, o]))
	const out: Reconciled = { resting: [], dropped: [], adopted: [], resized: [] }
	for (const c of chain) {
		if (!(c.remaining > 0)) continue
		const known = ours.get(c.orderId)
		if (known) {
			if (Math.abs(known.quantity - c.remaining) > 1e-9) out.resized.push(c.orderId)
			out.resting.push({ ...known, quantity: c.remaining })
			ours.delete(c.orderId)
		} else {
			out.adopted.push(c.orderId)
			out.resting.push({ orderId: c.orderId, ...decodeOrderId(c.orderId, priceDivisor), quantity: c.remaining })
		}
	}
	out.dropped = [...ours.keys()]
	return out
}

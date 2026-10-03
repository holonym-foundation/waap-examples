/**
 * Pure quote helpers for the DeepBook maker recipe: tick/lot rounding, own-order locks,
 * order-id decoding and chain reconciliation. The strategy itself is `lib/strategy.ts`.
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
 * place in this tick's PTB cannot spend (measured 2026-09-15: after a 20-DEEP bid filled, `lockedBalance.base` read 20 with no open order — the proceeds, still in `settled_balances`).
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

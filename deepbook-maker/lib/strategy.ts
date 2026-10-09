/**
 * The built-in maker: inventory-banded, cost-gated, passive quotes. Pure — no network,
 * no SDK, clock injected.
 *
 * ## What it does, in order
 *
 *  1. **Stop conditions first.** An external halt or pause (a limit, an unknown send, a
 *     recovery in progress) cancels every resting order and places nothing. So do
 *     unverified book parameters or fees, a stale book, and an unconfigured fee reserve.
 *  2. **Inventory.** Owned base `B` and quote `Q` are free + the SDK's `lockedBalance`
 *     (which already contains settled proceeds — they are not added again). Value
 *     `V = B·mid + Q`, base fraction `f = B·mid / V`.
 *  3. **Skew.** The quote centre moves off mid by up to `skewMaxBps`, down when long base
 *     (to sell more readily), up when short.
 *  4. **Band caps.** Each side is sized so that if it fills completely at its price —
 *     with the opposite side NOT assumed to fill — `f` stays inside
 *     [`bandLow`, `bandHigh`]. Price moves can still carry `f` outside the band; this
 *     bounds what our own orders add, not market risk.
 *  5. **Backing.** A side is sized to what the PTB can actually spend when it places:
 *     free balance plus what cancelling our own resting orders on that side unlocks
 *     (capped by the chain's locked figure). Settled proceeds are swept at the END of the
 *     PTB, so they back nothing this tick.
 *  6. **Size.** `min(maxOrderSize, band cap, backing)`, floored to the lot. Below the pool
 *     minimum, the side is not quoted and says why. A partly filled 17-of-20 order is
 *     kept as it is; it is not cancelled for being smaller than the clip.
 *  7. **Cost gate.** The full spread is widened to what covers a cycle's gas and fees
 *     at the size actually supported (`lib/costs.ts`). If that exceeds `maxSpreadBps`, or
 *     puts our quotes further from the touch than the liquidity rule allows, the maker
 *     pauses — it does not widen out of reach. The gate is re-checked on the final
 *     rounded prices.
 *  7b. **Liquidity pause with hysteresis.** The liquidity rule decides where NEW quotes may
 *     go; it is not a risk limit (an order further from the touch is less likely to be
 *     hit, not more). So a pause caused only by the rule places nothing but keeps resting
 *     orders that the keep rules in (9) would keep (`holdOnLiquidityPause`). Once paused,
 *     placing resumes only after `minLiquidityPauseMs` AND when the spread fits inside the
 *     rule by `resumeMargin`. Without this, a touch that flickers across the threshold
 *     cancels and re-places both orders on every flip (12 of 15 sends in live run 2b).
 *  8. **One side only.** When only one side can be quoted, it is placed only if it
 *     moves `f` back toward target (a bid when short base, an ask when long). A one-sided
 *     order that adds risk is not placed.
 *  9. **Keep, replace, or cancel.** A resting order is kept while its side is allowed,
 *     its size is within the cap, it is not near expiry, and its price is within
 *     tolerance — or it has not yet lived `minDwellMs`. Risk reasons (band, cap, expiry,
 *     pause, halt) cancel regardless of dwell; only a price drift waits for dwell.
 */
import { distanceBps, floorToLot, ownOrderLock, roundToTick } from './quotes.ts'
import type { TrackedOrder } from './state.ts'
import { cycleCost, cycleGate, requiredSpreadBps, type CycleAssumptions, type GateResult } from './costs.ts'

export interface StrategyConfig {
	targetBaseFraction: number
	bandLow: number
	bandHigh: number
	skewMaxBps: number
	maxOrderSize: number
	minSpreadBps: number
	maxSpreadBps: number
	/** Our full spread may be at most this multiple of the touch spread (own orders excluded). */
	touchMultiple: number
	/** Keep resting orders (subject to the keep rules) through a pause caused only by the liquidity rule. */
	holdOnLiquidityPause: boolean
	/** Once paused on the liquidity rule, resume only when spread ≤ (1 − this) × the rule's limit. */
	resumeMargin: number
	/** Once paused on the liquidity rule, stay paused at least this long. */
	minLiquidityPauseMs: number
	toleranceBps: number
	minDwellMs: number
	orderTtlMs: number
	/** Replace an order this long before it expires. */
	refreshBeforeExpiryMs: number
	staleBookMs: number
	payWithDeep: boolean
	/** Base units held back for DEEP fees when fees are nonzero and paid in DEEP (base is DEEP). */
	deepFeeReserve: number
	cycle: CycleAssumptions
}

export const DEFAULT_STRATEGY: StrategyConfig = {
	targetBaseFraction: 0.5,
	bandLow: 0.2,
	bandHigh: 0.8,
	skewMaxBps: 50,
	maxOrderSize: 20,
	minSpreadBps: 20,
	maxSpreadBps: 400,
	touchMultiple: 4,
	holdOnLiquidityPause: true,
	resumeMargin: 0.25,
	minLiquidityPauseMs: 10 * 60_000,
	toleranceBps: 50,
	minDwellMs: 5 * 60_000,
	orderTtlMs: 60 * 60_000,
	refreshBeforeExpiryMs: 5 * 60_000,
	staleBookMs: 30_000,
	payWithDeep: true,
	deepFeeReserve: 0,
	cycle: { replacementsPerCycle: 3, replaceShape: 'replace_one', failRate: 8 / 190, cyclesToAmortize: 10, quantile: 'p90' },
}

export interface BookView {
	bestBid: number
	bestAsk: number
	readAtMs: number
	/** Level-2 depth, if read: [price, quantity] best first. Used to exclude our own quotes from the touch. */
	bids?: Array<[number, number]>
	asks?: Array<[number, number]>
}

export interface StrategyInput {
	nowMs: number
	book: BookView
	params: { tickSize: number; lotSize: number; minSize: number; verified: boolean }
	fees: { makerFeeRate: number; verified: boolean }
	inv: { free: { base: number; quote: number }; locked: { base: number; quote: number } }
	resting: TrackedOrder[]
	halt?: string
	pause?: string
	/** When the current liquidity pause began (from the previous plan's `liquidityPausedSinceMs`). */
	liquidityPausedSinceMs?: number
}

export type Mode = 'quote' | 'pause' | 'halt' | 'inventory_limited'

export interface SideNote {
	side: 'bid' | 'ask'
	target?: number
	qty?: number
	cap?: number
	backing?: number
	action: 'keep' | 'place' | 'none'
	reason?: string
}

export interface StrategyPlan {
	mode: Mode
	reason?: string
	cancels: string[]
	place: Array<{ isBid: boolean; price: number; quantity: number }>
	sides: SideNote[]
	valueQuote?: number
	baseFraction?: number
	spreadBps?: number
	gate?: GateResult & { requiredSpreadBps: number; touchSpreadBps: number }
	/** For `inventory_limited`: what would make a side quotable again. */
	recovery?: string
	/** Liquidity-pause state for the caller to pass back next tick; undefined once quoting resumes. */
	liquidityPausedSinceMs?: number
}

const EPS = 1e-9

function cancelAll(resting: TrackedOrder[]): string[] {
	return resting.map((o) => o.orderId)
}

/** Touch spread in bps, with our own resting orders removed from the best levels where depth allows. */
export function touchSpreadBps(book: BookView, resting: TrackedOrder[], mid: number): number {
	const strip = (levels: Array<[number, number]> | undefined, best: number, ours: TrackedOrder[]) => {
		if (!levels?.length) return best
		for (const [price, qty] of levels) {
			const mine = ours.filter((o) => Math.abs(o.price - price) < EPS).reduce((s, o) => s + o.quantity, 0)
			if (qty - mine > EPS) return price
		}
		return best
	}
	const bid = strip(book.bids, book.bestBid, resting.filter((o) => o.isBid))
	const ask = strip(book.asks, book.bestAsk, resting.filter((o) => !o.isBid))
	return ((ask - bid) / mid) * 1e4
}

/** Largest bid size that keeps f ≤ high if it fills at `price` (opposite side not assumed). */
export function bidBandCap(B: number, V: number, mid: number, price: number, high: number): number {
	const room = high * V - B * mid
	return room <= 0 ? 0 : room / (mid * (1 - high) + high * price)
}

/** Largest ask size that keeps f ≥ low if it fills at `price`. */
export function askBandCap(B: number, V: number, mid: number, price: number, low: number): number {
	const room = B * mid - low * V
	return room <= 0 ? 0 : room / (mid * (1 - low) + low * price)
}

export function planStrategy(input: StrategyInput, cfg: StrategyConfig = DEFAULT_STRATEGY): StrategyPlan {
	const { book, params, nowMs, resting } = input
	// Other stops neither start nor end a liquidity pause: its clock carries through them.
	const stop = (mode: Mode, reason: string, extra: Partial<StrategyPlan> = {}): StrategyPlan => ({ mode, reason, cancels: cancelAll(resting), place: [], sides: [], liquidityPausedSinceMs: input.liquidityPausedSinceMs, ...extra })

	// (1) Stop conditions.
	if (input.halt) return stop('halt', input.halt)
	if (input.pause) return stop('pause', input.pause)
	if (!params.verified) return stop('pause', 'book_params_unverified')
	if (!input.fees.verified) return stop('pause', 'fees_unverified')
	if (nowMs - book.readAtMs > cfg.staleBookMs) return stop('pause', 'stale_book')
	if (!(book.bestBid > 0) || !(book.bestAsk > book.bestBid)) return stop('pause', 'book_unusable')
	const feeRate = input.fees.makerFeeRate
	if (feeRate > 0 && cfg.payWithDeep && !(cfg.deepFeeReserve > 0)) return stop('pause', 'fee_reserve_unconfigured')

	const mid = (book.bestBid + book.bestAsk) / 2

	// (2) Inventory: owned = free + SDK locked (settled is inside locked; never added twice).
	const B = input.inv.free.base + input.inv.locked.base
	const Q = input.inv.free.quote + input.inv.locked.quote
	const V = B * mid + Q
	if (!(V > 0)) return stop('pause', 'no_inventory')
	const f = (B * mid) / V
	const base = { valueQuote: V, baseFraction: f }

	// (3) Skew.
	const halfBand = (cfg.bandHigh - cfg.bandLow) / 2
	const d = Math.max(-1, Math.min(1, (f - cfg.targetBaseFraction) / halfBand))
	const centre = mid * (1 - (d * cfg.skewMaxBps) / 1e4)

	// (5) Backing. A cancelled resting order's funds come back inside the same PTB.
	const own = ownOrderLock(resting)
	const bidBacking = input.inv.free.quote + Math.min(own.quote, input.inv.locked.quote)
	const askBacking = input.inv.free.base + Math.min(own.base, input.inv.locked.base) - (feeRate > 0 && cfg.payWithDeep ? cfg.deepFeeReserve : 0)

	const pricesFor = (spreadBps: number) => {
		let bid = roundToTick(centre * (1 - spreadBps / 2 / 1e4), params.tickSize, 'down')
		let ask = roundToTick(centre * (1 + spreadBps / 2 / 1e4), params.tickSize, 'up')
		// Post-only must not cross: stay strictly behind the far touch.
		if (bid >= book.bestAsk - EPS) bid = roundToTick(book.bestAsk - params.tickSize, params.tickSize, 'down')
		if (ask <= book.bestBid + EPS) ask = roundToTick(book.bestBid + params.tickSize, params.tickSize, 'up')
		return { bid, ask }
	}
	const sizesFor = (p: { bid: number; ask: number }) => {
		const bidCap = bidBandCap(B, V, mid, p.bid, cfg.bandHigh)
		const askCap = askBandCap(B, V, mid, p.ask, cfg.bandLow)
		const bidQty = floorToLot(Math.max(0, Math.min(cfg.maxOrderSize, bidCap, bidBacking / p.bid)), params.lotSize)
		const askQty = floorToLot(Math.max(0, Math.min(cfg.maxOrderSize, askCap, askBacking)), params.lotSize)
		return { bidCap, askCap, bidQty, askQty }
	}

	// (6)-(7) Size at the narrowest spread, then widen to the cost floor for that size.
	const cost = cycleCost(cfg.cycle)
	let prices = pricesFor(cfg.minSpreadBps)
	let s = sizesFor(prices)
	const bidOk = (q: number) => q >= params.minSize - EPS && q > 0
	const quotable = { bid: bidOk(s.bidQty), ask: bidOk(s.askQty) }
	const deviation = f - cfg.targetBaseFraction
	// (8) One side only: allowed only if it moves f back toward target.
	if (quotable.bid && !quotable.ask && deviation >= 0) quotable.bid = false
	if (quotable.ask && !quotable.bid && deviation <= 0) quotable.ask = false

	const touchBps = touchSpreadBps(book, resting, mid)
	if (!quotable.bid && !quotable.ask) {
		const plan = stop('inventory_limited', 'no_side_reaches_min_size', base)
		plan.sides = [
			{ side: 'bid', qty: s.bidQty, cap: s.bidCap, backing: bidBacking, action: 'none', reason: s.bidCap < params.minSize ? 'band_limit' : bidBacking / prices.bid < params.minSize ? 'backing_limit' : 'adds_risk_one_sided' },
			{ side: 'ask', qty: s.askQty, cap: s.askCap, backing: askBacking, action: 'none', reason: s.askCap < params.minSize ? 'band_limit' : askBacking < params.minSize ? 'backing_limit' : 'adds_risk_one_sided' },
		]
		plan.recovery = inventoryRecovery({ B, Q, V, mid, prices, cfg, minSize: params.minSize, freeQuote: input.inv.free.quote })
		return plan
	}

	// The cycle the gate prices: both legs at the supported size. With one side quotable it
	// is the cycle that side starts or completes — the other leg priced at its target.
	const qFor = () => (quotable.bid && quotable.ask ? Math.min(s.bidQty, s.askQty) : quotable.bid ? s.bidQty : s.askQty)
	// Spread and size depend on each other (a wider spread moves the prices the band caps
	// use; a smaller size needs a wider spread), so solve them together until stable.
	let q = qFor()
	let reqBps = requiredSpreadBps(q, mid, cost.totalSui, feeRate)
	let spreadBps = Math.max(cfg.minSpreadBps, reqBps)
	const gateAt = () => ({ ...cycleGate({ bid: prices.bid, ask: prices.ask, qty: q, mark: mid, makerFeeRate: feeRate, cost }), requiredSpreadBps: reqBps, touchSpreadBps: touchBps })
	for (let i = 0; i < 6; i++) {
		if (spreadBps > cfg.maxSpreadBps) return stop('pause', 'cost_infeasible', { ...base, spreadBps, gate: gateAt() })
		prices = pricesFor(spreadBps)
		const s2 = sizesFor(prices)
		// Sizes may only shrink as the spread widens.
		s = { bidCap: Math.min(s.bidCap, s2.bidCap), askCap: Math.min(s.askCap, s2.askCap), bidQty: Math.min(s.bidQty, s2.bidQty), askQty: Math.min(s.askQty, s2.askQty) }
		quotable.bid = quotable.bid && bidOk(s.bidQty)
		quotable.ask = quotable.ask && bidOk(s.askQty)
		// Widening can drop a side; the one-sided rule (8) must hold again for what is left.
		if (quotable.bid && !quotable.ask && deviation >= 0) quotable.bid = false
		if (quotable.ask && !quotable.bid && deviation <= 0) quotable.ask = false
		if (!quotable.bid && !quotable.ask) return stop('inventory_limited', 'sizes_fell_below_min_at_gated_spread', base)
		q = qFor()
		reqBps = requiredSpreadBps(q, mid, cost.totalSui, feeRate)
		const g = gateAt()
		if (g.pass) break
		// Rounding or a smaller size left the cycle short: widen to exactly what this size
		// needs from the ROUNDED prices' shortfall, and go again.
		spreadBps = Math.max(spreadBps + (1e4 * -g.marginSui) / (q * mid) + 0.01, reqBps)
	}
	const gate = gateAt()
	if (!gate.pass) return stop('pause', 'cost_gate_failed_after_rounding', { ...base, spreadBps, gate })

	// (7b) Liquidity rule, with hysteresis once paused.
	const liqLimitBps = cfg.touchMultiple * Math.max(touchBps, cfg.minSpreadBps)
	const since = input.liquidityPausedSinceMs
	const liquidityBlock =
		spreadBps > liqLimitBps + EPS
			? 'outside_liquidity_rule'
			: since === undefined
				? undefined
				: spreadBps > (1 - cfg.resumeMargin) * liqLimitBps + EPS
					? 'liquidity_resume_margin'
					: nowMs - since < cfg.minLiquidityPauseMs
						? 'liquidity_min_pause'
						: undefined
	if (liquidityBlock && !cfg.holdOnLiquidityPause) return stop('pause', liquidityBlock, { ...base, spreadBps, gate, liquidityPausedSinceMs: since ?? nowMs })

	// (9) Keep, replace, cancel.
	const cancels: string[] = []
	const place: StrategyPlan['place'] = []
	const sides: SideNote[] = []
	for (const side of [
		{ isBid: true, name: 'bid' as const, target: prices.bid, qty: s.bidQty, cap: s.bidCap, backing: bidBacking, ok: quotable.bid },
		{ isBid: false, name: 'ask' as const, target: prices.ask, qty: s.askQty, cap: s.askCap, backing: askBacking, ok: quotable.ask },
	]) {
		const onSide = resting.filter((o) => o.isBid === side.isBid)
		let kept: TrackedOrder | undefined
		let reason: string | undefined
		for (const o of onSide) {
			if (kept) {
				cancels.push(o.orderId) // duplicate
				continue
			}
			const risk = !side.ok ? 'side_not_allowed' : o.quantity > side.cap + EPS ? 'exceeds_band_cap' : o.expiresAtMs !== undefined && o.expiresAtMs - nowMs <= cfg.refreshBeforeExpiryMs ? 'near_expiry' : o.quantity < params.minSize - EPS ? 'below_min_size' : undefined
			if (risk) {
				cancels.push(o.orderId)
				reason = risk
				continue
			}
			const drift = distanceBps(o.price, side.target)
			const dwelling = o.placedAtMs !== undefined && nowMs - o.placedAtMs < cfg.minDwellMs
			if (drift <= cfg.toleranceBps + EPS || dwelling) {
				kept = o
				reason = drift <= cfg.toleranceBps + EPS ? 'in_tolerance' : 'dwell'
				continue
			}
			cancels.push(o.orderId)
			reason = 'price_drift'
		}
		if (kept) {
			sides.push({ side: side.name, target: side.target, qty: kept.quantity, cap: side.cap, backing: side.backing, action: 'keep', reason })
			continue
		}
		if (side.ok && !liquidityBlock) {
			place.push({ isBid: side.isBid, price: side.target, quantity: side.qty })
			sides.push({ side: side.name, target: side.target, qty: side.qty, cap: side.cap, backing: side.backing, action: 'place', reason })
		} else {
			sides.push({ side: side.name, target: side.target, qty: side.qty, cap: side.cap, backing: side.backing, action: 'none', reason: reason ?? (liquidityBlock && side.ok ? liquidityBlock : side.qty < params.minSize ? 'below_min_size' : 'adds_risk_one_sided') })
		}
	}
	// Held: what the keep rules keep stays; what they cancel is cancelled; nothing new is placed.
	if (liquidityBlock) return { mode: 'pause', reason: liquidityBlock, cancels, place, sides, ...base, spreadBps, gate, liquidityPausedSinceMs: since ?? nowMs }
	return { mode: 'quote', cancels, place, sides, ...base, spreadBps, gate }
}

/** What would make at least one side quotable again — the "inventory-limited" instruction. */
export function inventoryRecovery(a: { B: number; Q: number; V: number; mid: number; prices: { bid: number; ask: number }; cfg: StrategyConfig; minSize: number; freeQuote: number }): string {
	const { B, V, mid, prices, cfg, minSize } = a
	// Extra base so an ask of minSize stays above bandLow.
	const needAsk = (minSize * (mid * (1 - cfg.bandLow) + cfg.bandLow * prices.ask) - (B * mid - cfg.bandLow * V)) / (mid * (1 - cfg.bandLow))
	// Extra quote so a bid of minSize stays below bandHigh and is backed.
	const needBidBand = (minSize * (mid * (1 - cfg.bandHigh) + cfg.bandHigh * prices.bid) - (cfg.bandHigh * V - B * mid)) / cfg.bandHigh
	const needBidBacking = minSize * prices.bid - a.freeQuote
	const needBid = Math.max(0, needBidBand, needBidBacking)
	return `neither side reaches the pool minimum of ${minSize} inside the band [${cfg.bandLow}, ${cfg.bandHigh}]: deposit about ${Math.max(0, needAsk).toFixed(2)} more base to quote an ask, or about ${needBid.toFixed(4)} more quote to quote a bid — or run cleanup (npm run stop) to withdraw everything. No swap is made automatically.`
}

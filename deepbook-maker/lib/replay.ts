/**
 * Offline replay: the live strategy (`planStrategy`, with your `.env` settings) run tick
 * by tick against a pool's real past trades. Nothing is signed or sent; no account needed.
 *
 * ## What is modelled, and how
 *
 * - **The book.** Historical order books are not public, so each tick's touch is taken
 *   from the trades: best bid = the last taker-SELL print, best ask = the last taker-BUY
 *   print, each at most 10 minutes old. That is a proxy, and it lags a fast market.
 * - **Fills.** A trade fills our resting order only if it printed strictly THROUGH our
 *   price (a taker sell below our bid, a taker buy above our ask), up to the trade's
 *   size. Our place in the queue is unknown, so equal-price prints do not count unless
 *   `fillAtPrice` is set. Our orders are assumed not to change what takers did.
 * - **Gas.** A fixed cost per transaction that changes orders (`costPerSendQuote`). The
 *   default is the mean of the 28 September live run's 15 requotes, 0.0014 SUI.
 * - **Inventory.** Free and locked balances, as the agent tracks them; a fill moves the
 *   locked side into free on the other side.
 *
 * The replay reports where the drawdown and gas limits would have stopped a live run,
 * but keeps going, so the whole window is scored.
 *
 * Calibration (2026-10-23): over the 30 minutes of the 22 October live run, the replay
 * predicts no crossing print for the orders the agent actually placed, matching the
 * zero fills seen on chain.
 */
import { planStrategy, type StrategyConfig } from './strategy.ts'
import type { TrackedOrder } from './state.ts'
import type { ReportFill } from './report.ts'

export interface Trade {
	timestamp: number
	price: number
	base_volume: number
	taker_is_bid: boolean
}

export interface ReplayOptions {
	cfg: StrategyConfig
	params: { tickSize: number; lotSize: number; minSize: number }
	makerFeeRate: number
	startBase: number
	startQuote: number
	pollMs: number
	costPerSendQuote: number
	fillAtPrice?: boolean
	maxDrawdownQuote?: number
	gasCapQuote?: number
	fromMs: number
	toMs: number
}

export interface ReplayResult {
	fills: ReportFill[]
	sends: number
	gasQuote: number
	ticks: number
	modes: Record<string, number>
	endMid: number
	endBase: number
	endQuote: number
	drawdownStopAtMs?: number
	gasCapStopAtMs?: number
	/** Mid proxy at any time inside the window, for markouts. */
	midAt: (ms: number) => number | undefined
}

const STALE_MS = 10 * 60_000

/** Last taker-buy and taker-sell prints at or before each time. Pure; exported for tests. */
export function touchSeries(trades: Trade[]) {
	const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
	const buys = sorted.filter((t) => t.taker_is_bid)
	const sells = sorted.filter((t) => !t.taker_is_bid)
	const lastAt = (xs: Trade[], ms: number) => {
		let lo = 0
		let hi = xs.length - 1
		let ans = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (xs[mid].timestamp <= ms) {
				ans = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		return ans >= 0 ? xs[ans] : undefined
	}
	const touch = (ms: number): { bid: number; ask: number } | undefined => {
		const b = lastAt(sells, ms)
		const a = lastAt(buys, ms)
		if (!a || !b || ms - a.timestamp > STALE_MS || ms - b.timestamp > STALE_MS) return undefined
		return { bid: Math.min(a.price, b.price), ask: Math.max(a.price, b.price) }
	}
	const midAt = (ms: number) => {
		const t = touch(ms)
		return t ? (t.bid + t.ask) / 2 : undefined
	}
	/** For scoring: the mid if both sides traded recently, else the last print within an hour. */
	const markAt = (ms: number) => {
		const m = midAt(ms)
		if (m !== undefined) return m
		const last = lastAt(sorted, ms)
		return last && ms - last.timestamp <= 60 * 60_000 ? last.price : undefined
	}
	return { sorted, touch, midAt, markAt }
}

export function replayTrades(trades: Trade[], o: ReplayOptions): ReplayResult {
	const { sorted, touch, markAt } = touchSeries(trades)
	let free = { base: o.startBase, quote: o.startQuote }
	let resting: TrackedOrder[] = []
	let i = 0
	let sends = 0
	let gas = 0
	let ticks = 0
	let seq = 0
	let liquidityPausedSinceMs: number | undefined
	let startValue: number | undefined
	let drawdownStopAtMs: number | undefined
	let gasCapStopAtMs: number | undefined
	const modes: Record<string, number> = {}
	const fills: ReportFill[] = []
	while (i < sorted.length && sorted[i].timestamp < o.fromMs) i++

	for (let now = o.fromMs; now <= o.toMs; now += o.pollMs) {
		// Trades since the last tick against what was resting.
		for (; i < sorted.length && sorted[i].timestamp <= now; i++) {
			const t = sorted[i]
			let left = t.base_volume
			for (const r of resting) {
				if (left <= 0) break
				const crosses = r.isBid
					? !t.taker_is_bid && (t.price < r.price || (o.fillAtPrice && t.price === r.price))
					: t.taker_is_bid && (t.price > r.price || (o.fillAtPrice && t.price === r.price))
				if (!crosses) continue
				const q = Math.min(r.quantity, left)
				left -= q
				r.quantity -= q
				if (r.isBid) free.base += q
				else free.quote += q * r.price
				fills.push({ atMs: t.timestamp, isBid: r.isBid, price: r.price, quantity: q })
			}
			resting = resting.filter((r) => r.quantity > 1e-9)
		}

		const tp = touch(now)
		if (!tp) continue
		ticks++
		const mid = (tp.bid + tp.ask) / 2
		const ask = tp.ask > tp.bid ? tp.ask : tp.bid + o.params.tickSize
		const lockedBase = resting.filter((r) => !r.isBid).reduce((s, r) => s + r.quantity, 0)
		const lockedQuote = resting.filter((r) => r.isBid).reduce((s, r) => s + r.quantity * r.price, 0)
		const value = (free.base + lockedBase) * mid + free.quote + lockedQuote
		startValue ??= value
		if (o.maxDrawdownQuote !== undefined && drawdownStopAtMs === undefined && startValue - value > o.maxDrawdownQuote) drawdownStopAtMs = now
		if (o.gasCapQuote !== undefined && gasCapStopAtMs === undefined && gas > o.gasCapQuote) gasCapStopAtMs = now

		const plan = planStrategy(
			{
				nowMs: now,
				book: { bestBid: tp.bid, bestAsk: ask, readAtMs: now },
				params: { ...o.params, verified: true },
				fees: { makerFeeRate: o.makerFeeRate, verified: true },
				inv: { free: { ...free }, locked: { base: lockedBase, quote: lockedQuote } },
				resting,
				liquidityPausedSinceMs,
			},
			o.cfg,
		)
		liquidityPausedSinceMs = plan.liquidityPausedSinceMs
		const key = plan.reason ? `${plan.mode} (${plan.reason})` : plan.mode
		modes[key] = (modes[key] ?? 0) + 1
		if (!plan.cancels.length && !plan.place.length) continue

		sends++
		gas += o.costPerSendQuote
		const cancel = new Set(plan.cancels)
		for (const r of resting.filter((r) => cancel.has(r.orderId))) {
			if (r.isBid) free.quote += r.quantity * r.price
			else free.base += r.quantity
		}
		resting = resting.filter((r) => !cancel.has(r.orderId))
		for (const p of plan.place) {
			if (p.isBid) free.quote -= p.quantity * p.price
			else free.base -= p.quantity
			resting.push({ orderId: `r${++seq}`, isBid: p.isBid, price: p.price, quantity: p.quantity, placedAtMs: now, expiresAtMs: now + o.cfg.orderTtlMs })
		}
	}

	const endMid = markAt(o.toMs) ?? sorted.at(-1)?.price ?? 0
	for (const r of resting) {
		if (r.isBid) free.quote += r.quantity * r.price
		else free.base += r.quantity
	}
	return { fills, sends, gasQuote: gas, ticks, modes, endMid, endBase: free.base, endQuote: free.quote, drawdownStopAtMs, gasCapStopAtMs, midAt: markAt }
}

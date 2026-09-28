/**
 * An offline tick simulator for the strategy — decisions only, never profit.
 *
 * It feeds `planStrategy` a scripted mid path and SCRIPTED fills, applies the plan to a
 * toy manager (cancels release locks, places lock funds, fills move inventory at the
 * order's price) and records what the strategy decided. Fills never come from the price
 * path: a price print says nothing about queue position or whether a taker arrived, so
 * a scenario states its fills explicitly. Use it to compare decisions (how many
 * replacements, when it pauses, how far inventory moves) — not to claim a return.
 */
import { planStrategy, type StrategyConfig, type StrategyPlan } from './strategy.ts'
import type { TrackedOrder } from './state.ts'

export interface ScenarioTick {
	mid: number
	/** Half the touch spread in bps (default 30 → 60-bps touch). */
	halfTouchBps?: number
	/** Fill this fraction (0-1) of our resting order on a side, at its price, before planning. */
	fill?: { bid?: number; ask?: number }
}

export interface ScenarioStep {
	tick: number
	mid: number
	plan: StrategyPlan
	base: number
	quote: number
	baseFraction: number
	valueQuote: number
	filled: Array<{ isBid: boolean; qty: number; price: number }>
}

export function runScenario(args: {
	ticks: ScenarioTick[]
	start: { base: number; quote: number }
	cfg: StrategyConfig
	pollMs?: number
	makerFeeRate?: number
	params?: { tickSize: number; lotSize: number; minSize: number }
}): ScenarioStep[] {
	const pollMs = args.pollMs ?? 60_000
	const params = { tickSize: 0.00001, lotSize: 1, minSize: 10, ...args.params, verified: true }
	let freeBase = args.start.base
	let freeQuote = args.start.quote
	let resting: TrackedOrder[] = []
	let seq = 0
	const steps: ScenarioStep[] = []

	args.ticks.forEach((t, i) => {
		const now = i * pollMs
		const filled: ScenarioStep['filled'] = []
		// Scripted fills against what is resting.
		for (const o of resting) {
			const frac = o.isBid ? t.fill?.bid : t.fill?.ask
			if (!frac) continue
			const q = Math.floor(o.quantity * frac)
			if (q <= 0) continue
			if (o.isBid) freeBase += q // quote was locked at placement
			else freeQuote += q * o.price
			o.quantity -= q
			filled.push({ isBid: o.isBid, qty: q, price: o.price })
		}
		resting = resting.filter((o) => o.quantity > 0)

		const lockedBase = resting.filter((o) => !o.isBid).reduce((s, o) => s + o.quantity, 0)
		const lockedQuote = resting.filter((o) => o.isBid).reduce((s, o) => s + o.quantity * o.price, 0)
		const half = (t.halfTouchBps ?? 30) / 1e4
		const plan = planStrategy(
			{
				nowMs: now,
				book: { bestBid: t.mid * (1 - half), bestAsk: t.mid * (1 + half), readAtMs: now },
				params,
				fees: { makerFeeRate: args.makerFeeRate ?? 0, verified: true },
				inv: { free: { base: freeBase, quote: freeQuote }, locked: { base: lockedBase, quote: lockedQuote } },
				resting: resting.map((o) => ({ ...o })),
			},
			args.cfg,
		)
		// Apply: cancels release, places lock.
		for (const id of plan.cancels) {
			const o = resting.find((r) => r.orderId === id)
			if (!o) continue
			if (o.isBid) freeQuote += o.quantity * o.price
			else freeBase += o.quantity
		}
		resting = resting.filter((o) => !plan.cancels.includes(o.orderId))
		for (const p of plan.place) {
			if (p.isBid) freeQuote -= p.quantity * p.price
			else freeBase -= p.quantity
			if (freeQuote < -1e-9 || freeBase < -1e-9) throw new Error(`scenario tick ${i}: plan placed an unbacked order`)
			resting.push({ orderId: String(++seq), isBid: p.isBid, price: p.price, quantity: p.quantity, placedAtMs: now, expiresAtMs: now + args.cfg.orderTtlMs })
		}
		const base = freeBase + resting.filter((o) => !o.isBid).reduce((s, o) => s + o.quantity, 0)
		const quote = freeQuote + resting.filter((o) => o.isBid).reduce((s, o) => s + o.quantity * o.price, 0)
		const valueQuote = base * t.mid + quote
		steps.push({ tick: i, mid: t.mid, plan, base, quote, baseFraction: (base * t.mid) / valueQuote, valueQuote, filled })
	})
	return steps
}

/** Count transactions a run of plans would submit (a tick with any cancel or place submits one). */
export function submissions(steps: ScenarioStep[]): number {
	return steps.filter((s) => s.plan.cancels.length > 0 || s.plan.place.length > 0).length
}

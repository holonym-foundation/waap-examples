/**
 * What a quoting cycle costs in gas — by transaction SHAPE, from receipts, with the
 * spread there is.
 *
 * ## Why shapes, not an average
 *
 * One average cost per transaction mixes a settle-only sweep, a one-order placement, a
 * two-order replacement and failures, and hides that net gas on Sui is mostly STORAGE:
 * computation is ~0.00012–0.00013 SUI on every shape below, while storage charged and
 * rebated runs to 0.07 SUI gross per transaction and nets to anything from −0.002 to
 * +0.0047 depending on which pool objects the transaction rewrote. So the gate adds up
 * the shapes a cycle actually sends, each at a stated quantile.
 *
 * ## The evidence
 *
 * `EXECUTED` is every receipt of three live runs of this recipe on DEEP/SUI mainnet
 * (25 Sep 6 h 55 m run, 24–25 Sep run, 27 Sep smoke at `f6bfee3`), classified by what the
 * transaction did (cancels built × places) from the run's own `tx_built` line, net =
 * computation + storage − rebate. `SIMULATED` is `devInspect` on 24 Sep against a
 * third-party manager with 9 open orders, heavier storage
 * than ours, so it serves as a pessimistic bound where executed samples are thin. These
 * are historical observations, not today's prices. The loop counts every receipt against
 * its gas cap, but this table is fixed: it is not updated from receipts.
 *
 * All figures SUI, net.
 */

export type Quantile = 'median' | 'p90' | 'max'

export interface ShapeCost {
	n: number
	median: number
	p90: number
	max: number
	evidence: 'executed' | 'simulated' | 'executed+simulated_bound'
	note?: string
}

export type Shape =
	| 'settle_only'
	| 'place_one'
	| 'place_two'
	| 'cancel_one'
	| 'replace_one'
	| 'replace_two'
	| 'failed'
	| 'create_manager'
	| 'deposit'
	| 'cleanup'

/** See the header. `max` of a thin executed sample is raised to the simulated bound. */
export const SHAPE_COSTS: Record<Shape, ShapeCost> = {
	settle_only: { n: 55, median: 0.000301, p90: 0.003183, max: 0.003184, evidence: 'executed' },
	place_one: { n: 74, median: 0.001821, p90: 0.001839, max: 0.004696, evidence: 'executed' },
	place_two: { n: 3, median: 0.000469, p90: 0.004214, max: 0.004214, evidence: 'executed+simulated_bound', note: '2 executed at 0.000469; simulated S2 0.004214 as the bound' },
	cancel_one: { n: 19, median: -0.000177, p90: 0.000302, max: 0.002762, evidence: 'executed' },
	replace_one: { n: 26, median: 0.000846, p90: 0.001848, max: 0.004724, evidence: 'executed' },
	replace_two: { n: 2, median: 0.004231, p90: 0.004231, max: 0.004231, evidence: 'executed+simulated_bound', note: '1 executed at −0.001023; simulated S4 0.004231 used throughout — too few executed samples' },
	failed: { n: 8, median: 0.000179, p90: 0.000183, max: 0.000189, evidence: 'executed', note: 'InsufficientGas on a WaaP-set budget' },
	create_manager: { n: 2, median: 0.001115, p90: 0.003071, max: 0.003071, evidence: 'executed+simulated_bound' },
	deposit: { n: 2, median: 0.002048, p90: 0.003026, max: 0.003026, evidence: 'executed' },
	cleanup: { n: 2, median: 0, p90: 0, max: 0, evidence: 'executed+simulated_bound', note: 'net −0.003236 executed, −0.013141 simulated: a rebate. Counted as 0, never negative. Gross ~0.0975 must still be fundable.' },
}

export function shapeCost(shape: Shape, q: Quantile, table: Record<Shape, ShapeCost> = SHAPE_COSTS): number {
	return Math.max(0, table[shape][q])
}

/**
 * One quoting cycle: our bid fills AND our ask fills for the same quantity. In between:
 *   - each fill leaves its side empty; the next tick places it again → 2 × `place_one`
 *   - `replacementsPerCycle` discretionary requotes as the mid drifts past tolerance
 *     (after the minimum dwell) → R × `replaceShape`
 *   - a fraction of sends fails and still costs → failRate × sends × `failed`
 *   - setup (create + deposit + first placement) and final cleanup, amortised over
 *     `cyclesToAmortize` cycles — a declared assumption, shown in every log line.
 */
export interface CycleAssumptions {
	replacementsPerCycle: number
	replaceShape: 'replace_one' | 'replace_two'
	failRate: number
	cyclesToAmortize: number
	quantile: Quantile
}

export const DEFAULT_CYCLE: CycleAssumptions = {
	// 25 Sep: 134 requotes for 399 DEEP ≈ 6.7 per 20-DEEP cycle at a 20-bps spread, 1-5 bps
	// tolerance. With 50-bps tolerance and a 5-minute dwell the 24 h replay made 42
	// requotes; 3 per cycle is the working assumption, 1 and 6.7 are
	// shown as sensitivity.
	replacementsPerCycle: 3,
	replaceShape: 'replace_one',
	failRate: 8 / 190, // 8 failed of ~190 live requotes across the three runs
	cyclesToAmortize: 10,
	quantile: 'p90',
}

export interface CycleCost {
	totalSui: number
	parts: Record<string, number>
	assumptions: CycleAssumptions
}

export function cycleCost(a: CycleAssumptions, table: Record<Shape, ShapeCost> = SHAPE_COSTS): CycleCost {
	const c = (s: Shape) => shapeCost(s, a.quantile, table)
	const sends = 2 + a.replacementsPerCycle
	const parts = {
		refills: 2 * c('place_one'),
		replacements: a.replacementsPerCycle * c(a.replaceShape),
		failures: a.failRate * sends * c('failed'),
		setupCleanupAmortised: (c('create_manager') + c('deposit') + c('place_two') + c('cleanup')) / Math.max(1, a.cyclesToAmortize),
	}
	return { totalSui: Object.values(parts).reduce((x, y) => x + y, 0), parts, assumptions: a }
}

/** Full spread (bps of mid) at which a cycle of `q` base covers `costSui` and both-side maker fees. */
export function requiredSpreadBps(q: number, mid: number, costSui: number, makerFeeRate: number): number {
	if (!(q > 0) || !(mid > 0)) return Number.POSITIVE_INFINITY
	return (1e4 * costSui) / (q * mid) + 2 * makerFeeRate * 1e4
}

export interface GateResult {
	pass: boolean
	matchedQty: number
	grossEdgeSui: number
	feesSui: number
	costSui: number
	marginSui: number
}

/**
 * Does a cycle at these FINAL (rounded, skewed) prices and supported quantity cover its
 * cost? Fees are the maker rate on each leg, valued in quote at the mark.
 *
 * This is conditional cost feasibility — "if both legs fill at these prices" — not an
 * expected-profit claim. Nothing here predicts fills.
 */
export function cycleGate(args: { bid: number; ask: number; qty: number; mark: number; makerFeeRate: number; cost: CycleCost }): GateResult {
	const { bid, ask, qty, mark, makerFeeRate } = args
	const grossEdgeSui = qty * (ask - bid)
	const feesSui = makerFeeRate * qty * (bid + ask) * (mark > 0 ? 1 : 0)
	const costSui = args.cost.totalSui
	const marginSui = grossEdgeSui - feesSui - costSui
	return { pass: qty > 0 && marginSui >= 0, matchedQty: qty, grossEdgeSui, feesSui, costSui, marginSui }
}

/** A sensitivity table for the README and progress notes. */
export function sensitivity(args: { mid: number; sizes: number[]; replacements: number[]; quantiles: Quantile[]; makerFeeRate?: number }) {
	const rows: Array<{ q: number; R: number; quantile: Quantile; cycleSui: number; requiredBps: number }> = []
	for (const quantile of args.quantiles)
		for (const R of args.replacements)
			for (const q of args.sizes) {
				const c = cycleCost({ ...DEFAULT_CYCLE, replacementsPerCycle: R, quantile })
				rows.push({ q, R, quantile, cycleSui: c.totalSui, requiredBps: requiredSpreadBps(q, args.mid, c.totalSui, args.makerFeeRate ?? 0) })
			}
	return rows
}

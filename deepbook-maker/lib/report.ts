/**
 * The run report card: what a run, live or replayed, actually earned.
 *
 * Five numbers, each computed from fills and mid prices only, so the same function
 * scores a live run (`agent.ts`, at stop) and an offline replay (`replay.ts`):
 *
 *   • fills, and DEEP bought and sold
 *   • spread captured at fill: how far inside the mid each fill was, in quote
 *   • markout at +5 and +30 min: the same, measured against the mid LATER. When this is
 *     below the spread at fill, the market moved against the fills: adverse selection.
 *   • trading P&L before gas, against simply holding the starting inventory: every
 *     fill's cash flow, with the DEEP it moved marked at the closing mid
 *   • gas, and the result after gas
 *
 * Holding is the honest baseline for a maker: the inventory's own price move is not
 * something the strategy earned or lost, so it is netted out.
 */

export interface ReportFill {
	atMs: number
	isBid: boolean
	price: number
	quantity: number
}

export interface ReportInput {
	fills: ReportFill[]
	/** Closing mid, quote per base. */
	endMid: number
	/** Gas the run paid, in quote (SUI). */
	gasQuote: number
	sends: number
	/** Mid at a time, if known. Without it the at-fill and markout lines are omitted. */
	midAt?: (ms: number) => number | undefined
	startMs: number
	endMs: number
}

export interface ReportCard {
	fills: number
	baseBought: number
	baseSold: number
	notionalQuote: number
	spreadAtFillQuote?: number
	markout5mQuote?: number
	markout30mQuote?: number
	/** Fills with no mid 30 minutes later (too recent, or a silent market). */
	markout30mExcluded: number
	tradingPnlQuote: number
	gasQuote: number
	resultQuote: number
	sends: number
	hours: number
}

/** Signed edge of one fill against a reference mid, in quote: positive is good for us. */
const edge = (f: ReportFill, mid: number) => (f.isBid ? mid - f.price : f.price - mid) * f.quantity

export function reportCard(i: ReportInput): ReportCard {
	const fills = [...i.fills].sort((a, b) => a.atMs - b.atMs)
	const at = (h: number) => {
		if (!i.midAt) return { sum: undefined, excluded: 0 }
		let sum = 0
		let excluded = 0
		for (const f of fills) {
			// "At fill" is the mid just BEFORE the fill: the fill's own print would move it.
			const t = h === 0 ? f.atMs - 1 : f.atMs + h
			const m = t <= i.endMs ? i.midAt(t) : undefined
			if (m === undefined) excluded++
			else sum += edge(f, m)
		}
		return { sum, excluded }
	}
	const tradingPnl = fills.reduce((s, f) => s + edge(f, i.endMid), 0)
	const m30 = at(30 * 60_000)
	return {
		fills: fills.length,
		baseBought: fills.filter((f) => f.isBid).reduce((s, f) => s + f.quantity, 0),
		baseSold: fills.filter((f) => !f.isBid).reduce((s, f) => s + f.quantity, 0),
		notionalQuote: fills.reduce((s, f) => s + f.price * f.quantity, 0),
		spreadAtFillQuote: at(0).sum,
		markout5mQuote: at(5 * 60_000).sum,
		markout30mQuote: m30.sum,
		markout30mExcluded: m30.excluded,
		tradingPnlQuote: tradingPnl,
		gasQuote: i.gasQuote,
		resultQuote: tradingPnl - i.gasQuote,
		sends: i.sends,
		hours: (i.endMs - i.startMs) / 3_600_000,
	}
}

const q = (x: number | undefined, unit: string) => (x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(6)} ${unit}`)
const bps = (x: number | undefined, notional: number) => (x === undefined || !(notional > 0) ? '' : ` (${((x / notional) * 1e4).toFixed(1)} bps of traded value)`)

/** The card as plain lines, for a terminal. */
export function renderReportCard(c: ReportCard, units = { base: 'DEEP', quote: 'SUI' }): string[] {
	const lines = [
		`fills: ${c.fills} over ${c.hours.toFixed(1)} h — bought ${c.baseBought.toFixed(2)} ${units.base}, sold ${c.baseSold.toFixed(2)} ${units.base}, traded ${c.notionalQuote.toFixed(4)} ${units.quote}`,
		`spread captured at fill:    ${q(c.spreadAtFillQuote, units.quote)}${bps(c.spreadAtFillQuote, c.notionalQuote)}`,
		`markout after 5 min:        ${q(c.markout5mQuote, units.quote)}${bps(c.markout5mQuote, c.notionalQuote)}`,
		`markout after 30 min:       ${q(c.markout30mQuote, units.quote)}${bps(c.markout30mQuote, c.notionalQuote)}${c.markout30mExcluded ? ` — ${c.markout30mExcluded} fill(s) without a price 30 min later, excluded` : ''}`,
		`trading P&L vs holding:     ${q(c.tradingPnlQuote, units.quote)}${bps(c.tradingPnlQuote, c.notionalQuote)}`,
		`gas (${c.sends} sends):           ${q(-c.gasQuote, units.quote)}`,
		`result after gas:           ${q(c.resultQuote, units.quote)}`,
	]
	if (c.fills === 0) lines.push('no fills: nothing traded, so the result is the gas. On a tight book a 30-minute run often fills nothing.')
	else if (c.markout30mQuote !== undefined && c.spreadAtFillQuote !== undefined && c.markout30mQuote < c.spreadAtFillQuote)
		lines.push('the market moved against the fills after they happened (adverse selection): the 30-minute markout is below the spread captured at fill.')
	return lines
}

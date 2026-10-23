/**
 * measure-requote-rate — the one number the budget could not supply.
 *
 *   npm run -s measure:requote
 *
 * ## Why this exists
 *
 * A gas budget for this loop is a range across `r`, the share of ticks
 * whose resting order has drifted outside `REQUOTE_TOLERANCE_BPS` and must be replaced.
 * `r` had never been measured on this loop, and it is what decides whether a run fits in
 * the wallet. The previous plan guessed it at 75 %; the review correctly refused the
 * guess.
 *
 * It does not have to be guessed. DeepBook's own `OrderFilled` events are a public price
 * series for this pool, so the planner's requote rule can be replayed against a real 24
 * hours of prices and `r` counted rather than assumed.
 *
 * ## What it does
 *
 * Walks `OrderFilled` for the pool over a window (default: the last 24 h), takes the
 * latest print at each poll instant as the mid, and applies the same rule
 * `lib/quotes.ts` applies — requote when either side's resting price is more than
 * `requoteToleranceBps` from its target, measured by `distanceBps`. It then prices the
 * result with the measured shape costs measured on mainnet, with and without
 * `SKIP_EMPTY_TICK`.
 *
 * **A traded print is not a mid.** The series is fills, so it carries the bid-ask
 * bounce: a run of alternating buys and sells looks like movement that a true mid would
 * not show. That biases `r` UP, so the numbers here are an over-estimate of the requote
 * count and therefore a conservative budget. Stated, not hidden.
 *
 * Read-only. `suix_queryEvents` and nothing else. Nothing is signed.
 *
 * Env: `WINDOW_HOURS` (24), `POLLS` ("60,300,600"), `TOLERANCES` ("10,25,50,100"),
 * `SPREAD_BPS` (20).
 */
import 'dotenv/config'

import { distanceBps, roundToTick } from './lib/quotes.ts'
import { DEEPBOOK_INDEXER, POOL_KEY } from './lib/waap.ts'

const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? '24')
const POLLS = (process.env.POLLS ?? '60,300,600').split(',').map(Number)
const TOLERANCES = (process.env.TOLERANCES ?? '10,25,50,100').split(',').map(Number)
const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? '20')
const TICK_SIZE = Number(process.env.TICK_SIZE ?? '0.00001')

/** Measured net cost per shape, measured on mainnet. */
const S0_SETTLE_ONLY = 0.0011488
const S4_TWO_SIDED_REQUOTE = 0.004231376

async function main() {
	const end = Date.now() - 5 * 60_000 // stay behind the head so the window is complete
	const start = end - WINDOW_HOURS * 3_600_000

	// The pool's trades come from the DeepBook indexer in 3-hour slices (the public
	// JSON-RPC event stream this used to walk is retired; see lib/chain.ts).
	const series: Array<{ ts: number; px: number }> = []
	let partialReason: string | null = null
	for (let t = start; t < end; t += 3 * 3_600_000) {
		const u = Math.min(end, t + 3 * 3_600_000)
		const url = `${DEEPBOOK_INDEXER}/trades/${POOL_KEY}?start_time=${Math.floor(t / 1000)}&end_time=${Math.floor(u / 1000)}&limit=10000`
		try {
			const res = await fetch(url)
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const trades = (await res.json()) as Array<{ timestamp: number; price: number }>
			if (trades.length >= 10000) partialReason = `a 3-hour slice hit the 10,000-trade page at ${new Date(t).toISOString()}`
			for (const x of trades) if (x.timestamp >= start && x.timestamp <= end) series.push({ ts: x.timestamp, px: x.price })
		} catch (err) {
			partialReason = `indexer read stopped at ${new Date(t).toISOString()}: ${String(err).slice(0, 120)}`
			console.error(`  ! ${partialReason}`)
			break
		}
	}
	series.sort((x, y) => x.ts - y.ts)
	const scanned = series.length

	if (series.length < 2) {
		console.error('not enough prints in the window')
		process.exit(1)
	}

	const pxs = series.map((s) => s.px)
	const covered = (series.at(-1)!.ts - series[0].ts) / 3_600_000
	console.log(`window ${new Date(start).toISOString()} → ${new Date(end).toISOString()} (${WINDOW_HOURS} h requested, ${covered.toFixed(2)} h covered by prints)`)
	if (partialReason) {
		console.log('')
		console.log(`**PARTIAL: ${partialReason}**`)
		console.log(`The rows below cover ${covered.toFixed(2)} h, not ${WINDOW_HOURS}. Scale the requote counts before using them as a 24 h budget, and say that you did.`)
		console.log('')
	}
	console.log(`pool ${POOL_KEY} · ${scanned} trades from the DeepBook indexer`)
	console.log(`price first ${pxs[0].toFixed(5)} last ${pxs.at(-1)!.toFixed(5)} min ${Math.min(...pxs).toFixed(5)} max ${Math.max(...pxs).toFixed(5)} · range ${(((Math.max(...pxs) - Math.min(...pxs)) / Math.min(...pxs)) * 100).toFixed(1)} %`)
	console.log('')
	console.log(`Costs applied: settle-only ${S0_SETTLE_ONLY} SUI, two-sided requote ${S4_TWO_SIDED_REQUOTE} SUI (measured).`)
	console.log('')
	console.log('| poll | tolerance bps | ticks | requotes | r | gas, SKIP off | gas, SKIP on |')
	console.log('|---|---|---|---|---|---|---|')

	const half = SPREAD_BPS / 2
	for (const pollS of POLLS) {
		for (const tol of TOLERANCES) {
			let i = 0
			let ticks = 0
			let requotes = 0
			let bid: number | null = null
			let ask: number | null = null
			const from = series[0].ts
			const to = series.at(-1)!.ts
			for (let t = from; t <= to; t += pollS * 1000) {
				while (i < series.length - 1 && series[i + 1].ts <= t) i++
				if (series[i].ts > t) continue
				const mid = series[i].px
				ticks++
				const bidTarget = roundToTick(mid * (1 - half / 10_000), TICK_SIZE, 'down')
				const askTarget = roundToTick(mid * (1 + half / 10_000), TICK_SIZE, 'up')
				const stale = bid === null || ask === null || distanceBps(bid, bidTarget) > tol || distanceBps(ask, askTarget) > tol
				if (stale) {
					requotes++
					bid = bidTarget
					ask = askTarget
				}
			}
			const r = requotes / ticks
			const off = ticks * (S0_SETTLE_ONLY + r * (S4_TWO_SIDED_REQUOTE - S0_SETTLE_ONLY))
			const on = requotes * S4_TWO_SIDED_REQUOTE
			console.log(`| ${pollS}s | ${tol} | ${ticks} | ${requotes} | ${r.toFixed(3)} | ${off.toFixed(3)} | ${on.toFixed(3)} |`)
		}
	}
	console.log('')
	console.log('Caveat: the series is TRADED PRINTS, not mids, so it carries the bid-ask bounce and over-states movement. r is an over-estimate and the budget is therefore conservative. One window, one pool.')
}

main().catch((err) => {
	console.error(String(err))
	process.exit(1)
})

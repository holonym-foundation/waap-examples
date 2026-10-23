/**
 * npm run replay — try your strategy on last week's real DeepBook trades before you fund
 * anything. Read-only: no account, no waap-cli, nothing signed.
 *
 * It downloads the pool's trades from DeepBook's public indexer (cached in
 * ./replay-cache), runs the same `planStrategy` and `.env` settings the live loop uses,
 * tick by tick, and prints the report card a live run prints at stop. How the book and
 * fills are modelled, and what that leaves out, is in lib/replay.ts and printed below.
 *
 *   npm run replay                       # the last 7 days, your .env settings
 *   REPLAY_DAYS=2 ORDER_SIZE=150 npm run replay
 *   REPLAY_FROM=2026-10-16 REPLAY_TO=2026-10-23 npm run replay
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'

import { envFlag, envNum, strategyFromEnv } from './lib/config.ts'
import { renderReportCard, reportCard } from './lib/report.ts'
import { replayTrades, type Trade } from './lib/replay.ts'

const NETWORK = process.env.NETWORK ?? 'mainnet'
const POOL_KEY = process.env.POOL_KEY ?? 'DEEP_SUI'
const INDEXER = (process.env.DEEPBOOK_INDEXER?.trim() || `https://deepbook-indexer.${NETWORK}.mystenlabs.com`).replace(/\/+$/, '')
const CACHE = path.resolve(process.env.REPLAY_CACHE_DIR ?? './replay-cache')
const SLICE_MS = 3 * 3_600_000
const PAGE = 10_000

const toMs = process.env.REPLAY_TO ? Date.parse(process.env.REPLAY_TO) : Math.floor(Date.now() / 3_600_000) * 3_600_000
const fromMs = process.env.REPLAY_FROM ? Date.parse(process.env.REPLAY_FROM) : toMs - envNum('REPLAY_DAYS', 7) * 86_400_000

async function getJson(url: string): Promise<unknown> {
	for (let i = 0; ; i++) {
		try {
			const r = await fetch(url)
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			return await r.json()
		} catch (err) {
			if (i === 3) throw new Error(`${url.split('?')[0]}: ${String(err)}`)
			await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
		}
	}
}

async function trades(): Promise<Trade[]> {
	fs.mkdirSync(CACHE, { recursive: true })
	const out: Trade[] = []
	for (let t = fromMs; t < toMs; t += SLICE_MS) {
		const u = Math.min(toMs, t + SLICE_MS)
		const file = path.join(CACHE, `${NETWORK}-${POOL_KEY}-${t}-${u}.json`)
		// Only a slice wholly in the past is cached; the latest one may still be filling.
		let slice: Trade[]
		if (fs.existsSync(file)) slice = JSON.parse(fs.readFileSync(file, 'utf8'))
		else {
			slice = (await getJson(`${INDEXER}/trades/${POOL_KEY}?start_time=${Math.floor(t / 1000)}&end_time=${Math.floor(u / 1000)}&limit=${PAGE}`)) as Trade[]
			if (slice.length >= PAGE) throw new Error(`more than ${PAGE} trades in 3 hours from ${new Date(t).toISOString()}; shorten the window`)
			if (u < Date.now() - 10 * 60_000) fs.writeFileSync(file, JSON.stringify(slice))
		}
		out.push(...slice.map((x) => ({ timestamp: x.timestamp, price: x.price, base_volume: x.base_volume, taker_is_bid: x.taker_is_bid })))
	}
	return out
}

async function poolParams() {
	const pools = (await getJson(`${INDEXER}/get_pools`)) as Array<{ pool_name: string; base_asset_decimals: number; quote_asset_decimals: number; tick_size: number; lot_size: number; min_size: number; base_asset_symbol: string; quote_asset_symbol: string }>
	const p = pools.find((x) => x.pool_name === POOL_KEY)
	if (!p) throw new Error(`pool ${POOL_KEY} not on the ${NETWORK} indexer`)
	const b = 10 ** p.base_asset_decimals
	return {
		tickSize: (p.tick_size * b) / 10 ** p.quote_asset_decimals / 1e9,
		lotSize: p.lot_size / b,
		minSize: p.min_size / b,
		units: { base: p.base_asset_symbol, quote: p.quote_asset_symbol },
	}
}

async function main() {
	const cfg = strategyFromEnv()
	const p = await poolParams()
	const tape = await trades()
	if (tape.length < 2) throw new Error('not enough trades in the window')
	const pollMs = envNum('POLL_MS', 60_000)
	const costPerSend = envNum('REPLAY_COST_PER_SEND_SUI', 0.0014)
	const r = replayTrades(tape, {
		cfg,
		params: { tickSize: p.tickSize, lotSize: p.lotSize, minSize: p.minSize },
		makerFeeRate: envNum('REPLAY_MAKER_FEE_RATE', 0),
		startBase: envNum('REPLAY_START_BASE', envNum('DRY_RUN_BASE_INVENTORY', 200)),
		startQuote: envNum('REPLAY_START_QUOTE', envNum('DRY_RUN_QUOTE_INVENTORY', 3.8)),
		pollMs,
		costPerSendQuote: costPerSend,
		fillAtPrice: envFlag('REPLAY_FILL_AT_PRICE', false),
		maxDrawdownQuote: envNum('MAX_DRAWDOWN_SUI', 0.05),
		gasCapQuote: envNum('GAS_CAP_SUI', 0.15),
		fromMs,
		toMs,
	})
	const card = reportCard({ fills: r.fills, endMid: r.endMid, gasQuote: r.gasQuote, sends: r.sends, midAt: r.midAt, startMs: fromMs, endMs: toMs })
	const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z'
	console.log(`replay ${POOL_KEY} ${iso(fromMs)} → ${iso(toMs)} · ${tape.length} trades · ORDER_SIZE ${cfg.maxOrderSize} · poll ${pollMs / 1000}s · start ${envNum('REPLAY_START_BASE', envNum('DRY_RUN_BASE_INVENTORY', 200))} ${p.units.base} + ${envNum('REPLAY_START_QUOTE', envNum('DRY_RUN_QUOTE_INVENTORY', 3.8))} ${p.units.quote}`)
	console.log(`ticks: ${r.ticks} · ${Object.entries(r.modes).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
	console.log('')
	for (const l of renderReportCard(card, p.units)) console.log(l)
	console.log('')
	if (r.drawdownStopAtMs) console.log(`a live run would have stopped at ${iso(r.drawdownStopAtMs)}: MAX_DRAWDOWN_SUI reached (the replay kept going to score the whole window)`)
	if (r.gasCapStopAtMs) console.log(`a live run would have stopped at ${iso(r.gasCapStopAtMs)}: GAS_CAP_SUI reached`)
	console.log('')
	console.log('how to read this: the book is estimated from trades (no historical order books are public); a trade fills')
	console.log(`you only if it printed strictly through your price${envFlag('REPLAY_FILL_AT_PRICE', false) ? ' or at it' : ''}; your orders are assumed not to change what takers did;`)
	console.log(`gas is ${costPerSend} SUI per order-changing transaction (REPLAY_COST_PER_SEND_SUI). It is a practice run, not a forecast.`)
}

main().catch((err) => {
	console.error(String(err))
	process.exit(1)
})

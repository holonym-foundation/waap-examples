/**
 * collect-fills — every fill the maker had in a window, and what they earned against gas.
 *
 *   AGENT_LOG_FILE=./logs/live-24h.jsonl OPENING_BASE=20 OPENING_BASIS=0.02087 npm run -s fills
 *
 * The loop collects fills as it runs (`fill` lines, `lib/fills.ts`). This is the
 * after-the-fact path and the one that produces the spread-vs-gas table: it derives the run
 * window from the log's own `agent_start` and `shutdown`, walks the chain's event stream
 * across that window, and joins the fills to the gas in the same log.
 *
 * It is also the check on the loop: if the walk finds a fill the run log has no `fill`
 * line for, collection was incomplete and any report must say so.
 *
 * Read-only — `suix_queryEvents` and `sui_getTransactionBlock`. Nothing is signed.
 *
 * Env:
 *   AGENT_LOG_FILE        the run log (default ./logs/deepbook-maker.jsonl)
 *   FILL_FROM / FILL_TO   ISO timestamps, overriding the window taken from the log
 *   DEEPBOOK_BALANCE_MANAGER_ID  the maker manager (default: from the log, then state.json)
 *   OPENING_BASE          DEEP held when the run started (default 0)
 *   OPENING_BASIS         the price that DEEP was ACTUALLY bought at — required if
 *                         OPENING_BASE > 0, because marking it at a mid invents spread
 *   CLOSING_MID           mid at the end of the run (default: the log's last book_read)
 */
import fs from 'node:fs'

import { FillLedger, walkFills, type CollectedFill } from './lib/fills.ts'
import { parseGasUsed, totalGas, type GasReceipt } from './lib/receipts.ts'
import { realizedSpread } from './lib/spread.ts'
import { anchorCursorAt, ENV_BALANCE_MANAGER_ID, fetchReceipt, MANAGER_KEY, POOL, POOL_KEY, poolScalars, queryFillEvents, STATE_FILE } from './lib/waap.ts'
import { resolveManager } from './lib/identity.ts'
import { peekManagerId } from './lib/state.ts'

const LOG = process.env.AGENT_LOG_FILE ?? './logs/deepbook-maker.jsonl'
const OPENING_BASE = Number(process.env.OPENING_BASE ?? '0')
const OPENING_BASIS = process.env.OPENING_BASIS ? Number(process.env.OPENING_BASIS) : undefined

interface LogRow {
	message?: string
	ts?: string
	[k: string]: unknown
}

function readLog(file: string): LogRow[] {
	if (!fs.existsSync(file)) return []
	const out: LogRow[] = []
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue
		try {
			out.push(JSON.parse(line) as LogRow)
		} catch {}
	}
	return out
}

async function main() {
	const rows = readLog(LOG)
	const starts = rows.filter((r) => r.message === 'agent_start')
	// The accounting window ends at CONFIRMED CLEANUP, not at loop exit: a fill can land
	// between the loop stopping and the cancel. The 27 Sep smoke collected to 08:59 while
	// its stop ran at 10:22.
	const shutdowns = rows.filter((r) => r.message === 'cleanup_confirmed' || r.message === 'cleanup_verified_clean' || r.message === 'process_exit' || r.message === 'shutdown')
	const books = rows.filter((r) => r.message === 'book_read')

	const fromIso = process.env.FILL_FROM ?? starts[0]?.ts
	const toIso = process.env.FILL_TO ?? shutdowns.at(-1)?.ts ?? new Date().toISOString()
	if (!fromIso) {
		console.error(`no agent_start in ${LOG} and no FILL_FROM set — cannot bound the window`)
		process.exit(1)
	}
	const fromMs = Date.parse(fromIso)
	const toMs = Date.parse(toIso)

	// The run log names its manager; state and environment, if set, must agree with it.
	const logged = starts[0]?.balanceManagerId as string | undefined
	const local = resolveManager({ stateId: peekManagerId(STATE_FILE), envId: ENV_BALANCE_MANAGER_ID }).id
	if (logged && local && logged.toLowerCase() !== local) {
		console.error(`manager conflict: the log's run used ${logged}, local state/environment says ${local}. Refusing to mix them.`)
		process.exit(1)
	}
	const managerId = logged ?? local
	if (!managerId) {
		console.error('no BalanceManager id — set DEEPBOOK_BALANCE_MANAGER_ID')
		process.exit(1)
	}
	if (OPENING_BASE > 0 && OPENING_BASIS === undefined) {
		console.error('OPENING_BASE is set but OPENING_BASIS is not. Opening inventory needs the price it was actually bought at — see lib/spread.ts.')
		process.exit(1)
	}

	const closingMid = Number(process.env.CLOSING_MID ?? (books.at(-1)?.mid as number | undefined) ?? 0)

	console.error(`window ${fromIso} → ${toIso} · manager ${managerId} · pool ${POOL_KEY}`)

	// The walk starts a little before the run so nothing on the boundary is dropped.
	const cursor = await anchorCursorAt(fromMs - 120_000)
	const ledger = new FillLedger()
	let pages = 0
	let scanned = 0
	let next = cursor
	// Loop the walk rather than raising maxPages: each call is bounded, so a long window
	// makes many small requests instead of one unbounded one, and progress is visible.
	for (let round = 0; round < 400; round++) {
		const res = await walkFills({ query: queryFillEvents, cursor: next, opts: { ...poolScalars(), poolId: POOL.address, balanceManagerId: managerId }, ledger, maxPages: 20, endTimeMs: toMs })
		pages += res.pages
		scanned += res.scanned
		next = res.cursor
		if (res.reachedEnd || (!res.truncated && res.pages < 20)) break
		if (round % 5 === 0) console.error(`  … ${pages} pages, ${scanned} events, ${ledger.size} fills`)
	}

	const fills = ledger.all()
	console.error(`walked ${pages} pages, ${scanned} OrderFilled events, ${fills.length} ours`)

	// What the run log itself recorded, so a gap is visible.
	const loggedKeys = new Set(rows.filter((r) => r.message === 'fill').map((r) => String(r.key ?? `${r.digest}:${r.eventSeq}`)))
	const missedByRun = fills.filter((f) => !loggedKeys.has(f.key))

	// Gas, from the log's tx_gas lines where present, otherwise refetched.
	const submitted = rows.filter((r) => r.message === 'tx_submitted')
	const receipts: GasReceipt[] = []
	const missingReceipts: string[] = []
	for (const s of submitted) {
		const digest = String(s.digest ?? '')
		if (!digest) continue
		const gas = parseGasUsed(await fetchReceipt(digest), digest)
		if (gas) receipts.push(gas)
		else missingReceipts.push(digest)
	}
	const gas = totalGas(receipts)

	const spread = realizedSpread({
		fills: fills.map((f: CollectedFill) => ({ isBid: f.isBid, price: f.price, quantity: f.quantity, fee: f.fee, feeAsset: f.feeAsset, role: f.role })),
		openingBase: OPENING_BASE,
		openingBasis: OPENING_BASIS ?? 0,
		closingMid,
	})

	console.log(`# fills and money — ${LOG}`)
	console.log('')
	console.log(`Window: ${fromIso} → ${toIso} (${((toMs - fromMs) / 3_600_000).toFixed(3)} h)`)
	console.log(`Manager: ${managerId} · pool ${POOL_KEY} ${POOL.address}`)
	console.log(`Source: suix_queryEvents MoveEventType OrderFilled, ${pages} pages, ${scanned} events scanned, filtered by pool AND maker manager`)
	console.log('')
	console.log('| # | time | side (isBid) | price | base | quote | taker manager | digest |')
	console.log('|---|---|---|---|---|---|---|---|')
	fills.forEach((f, i) => {
		console.log(
			`| ${i + 1} | ${new Date(Number(f.timestampMs)).toISOString()} | ${f.isBid ? 'bid (true)' : 'ask (false)'} | ${f.price} | ${f.quantity} | ${f.quoteQuantity} | ${f.takerBalanceManagerId.slice(0, 10)}… | ${f.txDigest.slice(0, 8)}… |`,
		)
	})
	if (fills.length === 0) console.log('| — | — | no fill for this manager in the window | — | — | — | — | — |')
	console.log('')
	console.log(`bid fills (isBid true): ${spread.buyFills} · ask fills (isBid false): ${spread.sellFills}`)
	if (missedByRun.length) {
		console.log('')
		console.log(`**${missedByRun.length} fill(s) the run log did NOT record.** Collection was incomplete; say so when reporting the spread-vs-gas figure:`)
		for (const f of missedByRun) console.log(`  ${f.key}  ${new Date(Number(f.timestampMs)).toISOString()}  ${f.isBid ? 'bid' : 'ask'} ${f.quantity} @ ${f.price}`)
	}
	console.log('')
	console.log('## Spread against gas')
	console.log('')
	console.log(`Opening inventory: ${OPENING_BASE} DEEP at a stated basis of ${OPENING_BASIS ?? 'n/a'} SUI/DEEP · closing mid ${closingMid}`)
	console.log('')
	console.log('| Quantity | Value |')
	console.log('|---|---|')
	console.log(`| Matched base (bought AND sold) | ${spread.matchedBase} DEEP |`)
	console.log(`| Realized spread, gross | ${spread.grossRealizedSui.toFixed(9)} SUI |`)
	console.log(`| Fees in SUI | ${spread.feeSui.toFixed(9)} SUI |`)
	console.log(`| Fees in base (reported, not converted) | ${spread.feeBase} |`)
	console.log(`| Fees in DEEP (reported, not converted) | ${spread.feeDeep} DEEP |`)
	console.log(`| Fills where we were the TAKER (must be disclosed) | ${spread.takerFills} |`)
	console.log(`| Self-matched fills (excluded) | ${spread.selfFills} |`)
	console.log(`| **Realized spread, net** | **${spread.realizedSui.toFixed(9)} SUI** |`)
	console.log(`| Open position at the end (not spread) | ${spread.openBase} DEEP, marked ${spread.unrealizedSui.toFixed(9)} SUI |`)
	console.log(`| Gas, net, over ${gas.count} receipts | ${gas.netSui.toFixed(9)} SUI |`)
	console.log(`| Gas, gross | ${gas.grossSui.toFixed(9)} SUI |`)
	console.log(`| **Realized spread ÷ gas (net)** | **${gas.netSui !== 0 ? (spread.realizedSui / gas.netSui).toFixed(3) : 'n/a'}×** |`)
	if (missingReceipts.length) console.log(`| Missing receipts — cost UNKNOWN, not zero | ${missingReceipts.length} |`)
	console.log('')
	console.log(`Submissions in this log: ${submitted.length}. Counters are per PROCESS: a deposit, a probe and a stop each run separately and append here, so compare one loop's \`shutdown.sendTxCalls\` against that loop's own \`tx_submitted\` lines, not against this total.`)
}

main().catch((err) => {
	console.error(String(err))
	process.exit(1)
})

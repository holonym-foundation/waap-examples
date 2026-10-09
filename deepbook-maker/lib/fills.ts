/**
 * Complete fill collection — the run-window event source.
 *
 * ## Why this file exists
 *
 * `agent.ts`'s `reconcileFromChain` reads fills out of `fetchTx(digest)` for the
 * transaction the agent itself just submitted. That finds a fill only when the agent
 * was the TAKER. A maker's whole job is the opposite case: someone else crosses the
 * resting order, in **their** transaction, which the agent never fetches. Measured:
 * the 2026-09-15 fill of maker order `384983548836765086299601320011` landed in digest
 * `7Tt99TuU5xuFGkAzRhjSAbFZHv2LPsGL1FyLNTmrB5NX` at 12:02:48Z — a transaction this
 * agent did not submit and has no record of. the spread-vs-gas figure cannot be measured from own-transaction
 * receipts.
 *
 * So fills are collected from the chain's event stream instead, filtered by pool and
 * by MAKER BalanceManager, walked forward from a cursor.
 *
 * ## What the fullnode actually supports (measured 2026-09-24, all three endpoints)
 *
 * Composite event filters do NOT work. `{"All":[…]}` returns
 * `-32602 trailing characters at line 1 column 9` and `{"Any":[…]}` returns
 * `'Any' queries are not supported by the fullnode`. Only one filter at a time:
 *
 *   • `MoveEventType` — every `::order_info::OrderFilled` on DeepBook, every pool.
 *   • `TimeRange`     — every event on Sui in a window, every type.
 *
 * Neither alone is what we want, but **event cursors are filter-agnostic**: a cursor
 * returned by a `TimeRange` query is accepted by a `MoveEventType` query and resumes at
 * the same point in the global event order. Verified 2026-09-24. So:
 *
 *   1. anchor once — a `TimeRange` query at the run's start gives the cursor,
 *   2. walk forward under `MoveEventType`, filtering pool and manager in this file.
 *
 * Volume. Measured 2026-09-24: ~865 `OrderFilled` events per hour across all DeepBook
 * pools. Re-measured 2026-09-28 in live run 2b: ~4,700 an hour (the steady-state
 * `fill_scan` lines), in bursts of up to ~11,000 an hour, and up to 6 pages of 50 per
 * 60–85 s tick. A 24 h run is now ~113,000 events, ~2,300 pages. The run-2 attempt with
 * 8 pages per tick was still behind after 30 minutes; run 2b with 80 reached the head on
 * its second tick. So the default budget is 80 pages (4,000 events ≈ 50 min of history per
 * tick): steady state uses under a tenth of it, and a restart's gap is backfilled at
 * about 50 min of history per tick with quoting paused until it reaches the head.
 *
 * ## Restart and dedup
 *
 * The cursor is persisted by the caller (the agent writes it to `state.json`). On a
 * restart the walk resumes from the saved cursor, so a gap is backfilled rather than
 * skipped. A page may be re-read after a failure part-way through, so every fill
 * carries a stable identity — `txDigest:eventSeq`, the chain's own event id — and
 * `FillLedger` drops anything it has already seen.
 */
import { parseOrderFilled, type Fill, type ParseOptions, type RpcEvent } from './events.ts'

/** All-pool `OrderFilled` events per hour, measured in live run 2b (2026-09-28). */
export const MEASURED_FILL_EVENTS_PER_HOUR = 4_700
/** Default pages per tick (see "Volume" above). */
export const DEFAULT_FILL_SCAN_PAGES = 80

/** The `(txDigest, eventSeq)` pair the JSON-RPC uses to page through events. */
export interface EventCursor {
	txDigest: string
	eventSeq: string
}

/** One event as `suix_queryEvents` returns it — `RpcEvent` plus its id and timestamp. */
export interface QueriedEvent extends RpcEvent {
	id?: EventCursor
	timestampMs?: string
}

/** One page of `suix_queryEvents`. */
export interface EventPage {
	data: QueriedEvent[]
	nextCursor?: EventCursor | null
	hasNextPage?: boolean
}

/**
 * The one network call this module needs, injected so the walk can be tested without
 * a fullnode. `descending` false walks forward in time from the cursor.
 */
export type QueryEvents = (args: {
	eventType: string
	cursor: EventCursor | null
	limit: number
	descending: boolean
}) => Promise<EventPage>

/** A fill with the chain's own identity attached. */
export interface CollectedFill extends Fill {
	txDigest: string
	eventSeq: string
	/** `txDigest:eventSeq` — stable across re-reads, unique per event. */
	key: string
}

/**
 * DeepBook's event structs carry the ORIGINAL package id, not the upgraded one the SDK
 * exports. See the header of `events.ts`; this is the same string, read off mainnet.
 */
export const DEEPBOOK_EVENT_PACKAGE =
	process.env.DEEPBOOK_EVENT_PACKAGE?.trim() ||
	'0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809'

export const ORDER_FILLED_TYPE = `${DEEPBOOK_EVENT_PACKAGE}::order_info::OrderFilled`

export function fillKey(txDigest: string, eventSeq: string): string {
	return `${txDigest}:${eventSeq}`
}

export function cursorOf(event: QueriedEvent): EventCursor | null {
	return event.id?.txDigest ? { txDigest: event.id.txDigest, eventSeq: String(event.id.eventSeq) } : null
}

/**
 * Turn one page of raw events into the fills that belong to us.
 *
 * `parseOrderFilled` already does the type match, the pool/maker-manager filter and the
 * scalar conversion, and it takes `{ events }` — the same shape a page's `data` is. It
 * is reused verbatim so a queried fill and a receipt-parsed fill cannot drift apart.
 * The only thing added here is the event's identity, which a transaction receipt does
 * not carry per event.
 */
export function collectFillsFromPage(events: QueriedEvent[], opts: ParseOptions): CollectedFill[] {
	const out: CollectedFill[] = []
	for (const e of events) {
		const [fill] = parseOrderFilled({ events: [e] }, opts)
		if (!fill) continue
		const txDigest = e.id?.txDigest ?? ''
		const eventSeq = String(e.id?.eventSeq ?? '')
		out.push({ ...fill, txDigest, eventSeq, key: fillKey(txDigest, eventSeq) })
	}
	return out
}

/**
 * Everything seen so far, keyed by the chain's event id.
 *
 * `add` returns only what was NEW, so a caller can log one line per genuinely new fill
 * however many times a page is re-read.
 */
export class FillLedger {
	private readonly seen = new Map<string, CollectedFill>()

	constructor(existing: Iterable<CollectedFill> = []) {
		for (const f of existing) this.seen.set(f.key, f)
	}

	add(fills: Iterable<CollectedFill>): CollectedFill[] {
		const fresh: CollectedFill[] = []
		for (const f of fills) {
			if (this.seen.has(f.key)) continue
			this.seen.set(f.key, f)
			fresh.push(f)
		}
		return fresh
	}

	has(key: string): boolean {
		return this.seen.has(key)
	}

	get size(): number {
		return this.seen.size
	}

	/** In timestamp order, then event id — the order a spread calculation needs. */
	all(): CollectedFill[] {
		return [...this.seen.values()].sort(
			(a, b) => Number(a.timestampMs) - Number(b.timestampMs) || a.key.localeCompare(b.key),
		)
	}
}

/**
 * Why a walk stopped. Only `head` and `end_time` mean "caught up"; `page_budget` means
 * there may be more, and the returned cursor is where to carry on.
 *
 * The old boolean `truncated = pages >= maxPages` was wrong at the boundary: a walk
 * whose LAST allowed page was also the last page of the stream (`hasNextPage: false`)
 * reported `truncated: true`, so a caller gating on it would wait forever for a
 * backfill that had already finished.
 */
export type WalkCompletion = 'head' | 'end_time' | 'page_budget'

export interface WalkResult {
	/** Every fill for this pool and manager found in the walk, deduped. */
	fills: CollectedFill[]
	/** Where to resume next time. Unchanged when nothing moved. */
	cursor: EventCursor | null
	/** How many pages were read, and how many raw events crossed the filter. */
	pages: number
	scanned: number
	completion: WalkCompletion
	/** `completion === 'page_budget'`. Kept for callers that read the old field. */
	truncated: boolean
	/** `completion === 'end_time'`. */
	reachedEnd: boolean
	/** Timestamp of the last event read, ms — the watermark the walk has provably covered. */
	watermarkMs?: number
}

/**
 * Walk forward from `cursor` collecting our fills, and return where to resume.
 *
 * Stops at the head of the stream, at `endTimeMs`, or at `maxPages` — whichever comes
 * first — and says which in `completion`.
 *
 * The cursor is advanced only past pages that were fully processed, so a throw
 * mid-walk leaves the caller's saved cursor pointing at un-processed events rather than
 * past them. Dedup changes are staged until the entire walk succeeds, so retrying
 * after a later page fails still returns the earlier pages' fills to the caller.
 */
export async function walkFills(args: {
	query: QueryEvents
	cursor: EventCursor | null
	opts: ParseOptions
	ledger?: FillLedger
	limit?: number
	maxPages?: number
	/** Stop once an event's `timestampMs` passes this. Omit to walk to the head. */
	endTimeMs?: number
}): Promise<WalkResult> {
	const { query, opts, endTimeMs } = args
	const ledger = args.ledger ?? new FillLedger()
	const staged = new FillLedger()
	const limit = args.limit ?? 50
	const maxPages = args.maxPages ?? DEFAULT_FILL_SCAN_PAGES

	let cursor = args.cursor
	let pages = 0
	let scanned = 0
	let completion: WalkCompletion = 'page_budget'
	let watermarkMs: number | undefined
	const fills: CollectedFill[] = []

	while (pages < maxPages) {
		const page = await query({ eventType: ORDER_FILLED_TYPE, cursor, limit, descending: false })
		pages++
		const data = page.data ?? []
		scanned += data.length

		// Trim the page at the end boundary before parsing, so a fill after the window is
		// never counted and the cursor never advances past it.
		let usable = data
		let hitEnd = false
		if (endTimeMs !== undefined) {
			const cut = data.findIndex((e) => Number(e.timestampMs) > endTimeMs)
			if (cut !== -1) {
				usable = data.slice(0, cut)
				hitEnd = true
			}
		}

		fills.push(...staged.add(collectFillsFromPage(usable, opts).filter((f) => !ledger.has(f.key))))
		const lastTs = Number(usable.at(-1)?.timestampMs)
		if (Number.isFinite(lastTs)) watermarkMs = lastTs

		if (hitEnd) {
			// Resume from the last event INSIDE the window, not from the page's cursor.
			const last = usable.at(-1)
			const c = last ? cursorOf(last) : null
			if (c) cursor = c
			completion = 'end_time'
			break
		}

		cursor = page.nextCursor ?? cursor
		if (!page.hasNextPage) {
			completion = 'head'
			break
		}
	}

	ledger.add(fills)
	return {
		fills,
		cursor,
		pages,
		scanned,
		completion,
		truncated: completion === 'page_budget',
		reachedEnd: completion === 'end_time',
		watermarkMs,
	}
}

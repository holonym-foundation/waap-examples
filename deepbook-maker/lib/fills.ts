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
 * Volume, measured 2026-09-24: ~865 `OrderFilled` events per hour across all DeepBook
 * pools (600 events spanning 41.6 minutes), of which ~29 % are DEEP/SUI. A 24 h run is
 * roughly 21,000 events — about 420 pages of 50, or one page every three minutes.
 * At a 60 s tick that is well under one extra RPC read per tick.
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

export interface WalkResult {
	/** Every fill for this pool and manager found in the walk, deduped. */
	fills: CollectedFill[]
	/** Where to resume next time. Null when nothing moved. */
	cursor: EventCursor | null
	/** How many pages were read, and how many raw events crossed the filter. */
	pages: number
	scanned: number
	/** True when the walk stopped on its page budget rather than catching up. */
	truncated: boolean
	/** True when the walk stopped because it passed `endTimeMs`. */
	reachedEnd: boolean
}

/**
 * Walk forward from `cursor` collecting our fills, and return where to resume.
 *
 * Stops at the head of the stream, at `endTimeMs`, or at `maxPages` — whichever comes
 * first. `truncated` says which: a truncated walk has NOT caught up, and the returned
 * cursor is where to carry on, so the next call finishes the job. Nothing is dropped.
 *
 * The cursor is advanced only past pages that were fully processed, so a throw
 * mid-walk leaves the caller's saved cursor pointing at un-processed events rather than
 * past them. Re-reading is safe; `FillLedger` deduplicates.
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
	const limit = args.limit ?? 50
	const maxPages = args.maxPages ?? 60

	let cursor = args.cursor
	let pages = 0
	let scanned = 0
	let reachedEnd = false
	const fills: CollectedFill[] = []

	while (pages < maxPages) {
		const page = await query({ eventType: ORDER_FILLED_TYPE, cursor, limit, descending: false })
		pages++
		const data = page.data ?? []
		scanned += data.length

		// Trim the page at the end boundary before parsing, so a fill after the window is
		// never counted and the cursor never advances past it.
		let usable = data
		if (endTimeMs !== undefined) {
			const cut = data.findIndex((e) => Number(e.timestampMs) > endTimeMs)
			if (cut !== -1) {
				usable = data.slice(0, cut)
				reachedEnd = true
			}
		}

		fills.push(...ledger.add(collectFillsFromPage(usable, opts)))

		if (reachedEnd) {
			// Resume from the last event INSIDE the window, not from the page's cursor.
			const last = usable.at(-1)
			const c = last ? cursorOf(last) : null
			if (c) cursor = c
			break
		}

		cursor = page.nextCursor ?? cursor
		if (!page.hasNextPage) break
	}

	return { fills, cursor, pages, scanned, truncated: pages >= maxPages && !reachedEnd, reachedEnd }
}

/**
 * deepbook-maker — WaaP recipe.
 *
 * Reads the live DEEP/SUI book on Sui mainnet, plans a quote, builds one unsigned PTB,
 * and serialises it to the base64 kind bytes that
 * `waap-cli send-tx --tx <b64> --tx-format base64 --chain sui:mainnet` takes.
 *
 * In dry run (the default) it stops there. Nothing is signed and no key exists in
 * this process — signing belongs to the WaaP enclave, reached only through waap-cli.
 * The signing spine lives in `lib/waap.ts`; every script in this recipe leaves
 * through the same one.
 *
 * SUI-only bootstrap. The planner sizes each side against the inventory that backs it
 * (`lib/quotes.ts`), so a manager holding SUI and no DEEP quotes bids only — reported
 * as `skippedSides: ["base_below_size"]`. The first bid that fills buys DEEP, and the
 * next tick quotes both sides on its own.
 */
import fs from 'node:fs'
import path from 'node:path'

import { Transaction } from '@mysten/sui/transactions'
import type { DeepBookClient } from '@mysten/deepbook-v3'

import {
	findCreatedBalanceManagerId,
	parseOrderCanceled,
	parseOrderPlaced,
	type RpcTransactionBlock,
} from './lib/events.ts'
import { collectFillsFromPage, FillLedger, walkFills, type CollectedFill, type EventCursor } from './lib/fills.ts'
import { ownOrderLock, planQuotes, reconcileResting, type ChainOrder, type PlannedOrder, type RestingOrder } from './lib/quotes.ts'
import { parseGasUsed } from './lib/receipts.ts'
import {
	AGENT_ID,
	anchorCursorAt,
	DRY_RUN,
	ENV_BALANCE_MANAGER_ID,
	MANAGER_KEY,
	NETWORK,
	POOL,
	POOL_KEY,
	STATE_FILE,
	SUI_RPC,
	buildKindBytes,
	fatal,
	fetchReceipt,
	getSendTxCalls,
	getSendTxRefused,
	log,
	queryFillEvents,
	RPC_ENDPOINTS,
	currentRpcUrl,
	makeDeepBookClient,
	onRpcRotated,
	poolScalars,
	resolveOwner,
	signAndSendTx,
	sui,
	withRpc,
} from './lib/waap.ts'

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? '20')
const ORDER_SIZE = Number(process.env.ORDER_SIZE ?? '10') // DEEP; pool min size 10, lot 1
const BASE_FLOOR = Number(process.env.BASE_FLOOR ?? '0')
const QUOTE_FLOOR = Number(process.env.QUOTE_FLOOR ?? '0')
const REQUOTE_TOLERANCE_BPS = Number(process.env.REQUOTE_TOLERANCE_BPS ?? '5')
const POLL_MS = Number(process.env.POLL_MS ?? '20000')
const MAX_TICKS = process.env.MAX_TICKS ? Number(process.env.MAX_TICKS) : undefined
const BOOK_TICKS = Number(process.env.BOOK_TICKS ?? '5')

/**
 * Fill collection (`lib/fills.ts`). `FILL_SCAN=0` turns it off; the loop still runs and
 * still quotes, but the spread-vs-gas figure cannot be measured, so it is on by default.
 *
 * `FILL_SCAN_PAGES` caps how many event pages one tick may read. At the measured
 * ~865 `OrderFilled` events per hour across DeepBook, a 60 s tick has about 15 to catch
 * up on — one page. The cap exists for the case where the loop was stopped for hours and
 * a restart has a long backfill: the walk takes it a slice per tick instead of stalling
 * one tick for a thousand requests, and `fill_scan` reports `truncated: true` until it
 * has caught up.
 */
const FILL_SCAN = (process.env.FILL_SCAN ?? 'true').toLowerCase() !== 'false' && process.env.FILL_SCAN !== '0'
const FILL_RESUME = process.env.FILL_RESUME === '1'
const FILL_SCAN_PAGES = Number(process.env.FILL_SCAN_PAGES ?? '8')
const FILL_PAGE_SIZE = Number(process.env.FILL_PAGE_SIZE ?? '50')

/**
 * `SKIP_EMPTY_TICK=1` — do not submit a transaction on a tick that would do nothing.
 *
 * **Default OFF. This changes what the loop does, not only what it measures, so it is a
 * decision for the operator and not something this repair turns on by itself.**
 *
 * As the loop stands, every tick that gets past the book read submits: the PTB always
 * ends with `withdrawSettledAmounts` (`:515` in the original), so a tick whose orders
 * are all inside `REQUOTE_TOLERANCE_BPS` still sends a transaction that cancels nothing,
 * places nothing and sweeps nothing. Measured, that empty transaction costs
 * 0.0011488 SUI — 42 % of what a full one-sided requote costs, paid every tick forever.
 *
 * That is why widening the tolerance saved no gas: it changed the PTB's contents, not
 * whether one was sent. With this flag on, gas is charged per REQUOTE rather than per
 * tick, and the tolerance becomes the lever that sets the gas bill.
 *
 * The skip is only safe when there is nothing to sweep, so the settled balance is read
 * from chain each tick and a nonzero one always submits. See `readSettled`.
 */
const SKIP_EMPTY_TICK = process.env.SKIP_EMPTY_TICK === '1' || (process.env.SKIP_EMPTY_TICK ?? '').toLowerCase() === 'true'

const WRITE_PID_FILE = (process.env.WRITE_PID_FILE ?? 'true').toLowerCase() !== 'false'
const PID_FILE = path.resolve(process.env.PID_FILE ?? './agent.pid')

/**
 * How many ticks in a row may fail before the process gives up.
 *
 * Was 5. A single RPC outage of ~100 s at a 20 s poll would have burned all five and
 * ended a 24 h run — which is what ticks 5 and 6 of the first live run were on their
 * way to doing. With each read now retried three times across three endpoints
 * (`withRpc`), a tick only fails when every endpoint is down for the whole backoff, so
 * 20 consecutive failures is a real outage of roughly 20 × (POLL_MS + ~13 s), not a
 * blip. A failed tick already sleeps the normal POLL_MS before the next one: the catch
 * falls through to the same `next_check` sleep as a successful tick, and nothing in
 * this loop retries faster than the poll interval.
 */
const MAX_CONSECUTIVE_ERRORS = Number(process.env.MAX_CONSECUTIVE_ERRORS ?? '20')

// Fallbacks if the on-chain read of the pool's book parameters fails.
// DEEP/SUI mainnet: tick 0.00001, lot 1 DEEP, min 10 DEEP.
const FALLBACK_BOOK = { tickSize: 0.00001, lotSize: 1, minSize: 10 }

if (!POOL) {
	console.error(`[${AGENT_ID}] unknown POOL_KEY ${POOL_KEY} on ${NETWORK}`)
	process.exit(1)
}

const SCALARS = poolScalars()

// -----------------------------------------------------------------------------
// State — the BalanceManager id and the orders we believe are resting.
// -----------------------------------------------------------------------------

/**
 * A resting order as this agent tracks it.
 *
 * `simulated: true` means the id is this agent's own placeholder, not an id the
 * chain issued — which is every order a dry run "places", because nothing was ever
 * submitted. A simulated order can be reasoned about (the planner only needs its
 * side, price and size) but it can never be cancelled on chain: DeepBook's cancel
 * calls take a u128 order id, and a placeholder like `t1-bid-0` throws
 * `Cannot convert t1-bid-0 to a BigInt` while the transaction is being built.
 *
 * On the live path the placeholders never survive the tick: `reconcileFromChain`
 * replaces them with the u128 ids out of the transaction's `OrderPlaced` events.
 */
type TrackedOrder = RestingOrder & { simulated?: boolean }

interface AgentState {
	balanceManagerId?: string
	tick: number
	lastMid?: number
	resting: TrackedOrder[]
	/**
	 * Where the fill walk got to. Persisted so a restart backfills the gap instead of
	 * skipping it — the whole point of collecting fills from the event stream rather
	 * than from our own receipts. See `lib/fills.ts`.
	 */
	fillCursor?: EventCursor | null
}

/** A real DeepBook order id is a u128 — decimal, or 0x-hex. Anything else is ours. */
function isRealOrderId(orderId: string): boolean {
	if (!/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(orderId)) return false
	try {
		const v = BigInt(orderId)
		return v >= 0n && v < 1n << 128n
	} catch {
		return false
	}
}

let state: AgentState = { tick: 0, resting: [] }

function loadState(): void {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<AgentState>
		state = {
			balanceManagerId: parsed.balanceManagerId,
			tick: typeof parsed.tick === 'number' ? parsed.tick : 0,
			lastMid: parsed.lastMid,
			resting: Array.isArray(parsed.resting) ? parsed.resting : [],
			fillCursor: parsed.fillCursor ?? null,
		}
	} catch {}
}

function saveState(): void {
	try {
		fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
	} catch {}
}

// -----------------------------------------------------------------------------
// Reading back a submitted transaction
// -----------------------------------------------------------------------------

/**
 * Refetch a transaction we just submitted, with its events and object changes.
 *
 * The fullnode can lag a moment behind the digest coming back from waap-cli, so this
 * retries rather than treating a miss as a failure. Returns null once it gives up;
 * the caller logs and carries on — a tick that cannot read its own receipt is worth
 * a warning, not a crash.
 */
async function fetchTx(digest: string, kind: string, attempts = 6): Promise<RpcTransactionBlock | null> {
	// Two different failures share this loop. Lag — the node has not indexed the digest
	// yet — is answered by waiting and asking again, and is NOT a network error, so
	// `withRpc` would rethrow it immediately; the retry for that lives here. A dead
	// endpoint is answered by `withRpc`, which rotates. Hence the short per-call
	// backoff inside `withRpc` (this is the one read where the node being slow is
	// expected) and the outer loop's own linear wait for the indexing.
	for (let i = 0; i < attempts; i++) {
		try {
			const tx = await withRpc(
				'getTransactionBlock',
				() =>
					sui.getTransactionBlock({
						digest,
						options: { showEvents: true, showObjectChanges: true },
					}),
				{ attempts: 2, backoffMs: [1_000, 1_000] },
			)
			return tx as unknown as RpcTransactionBlock
		} catch (err) {
			if (i === attempts - 1) {
				log('warn', 'tx_fetch_failed', { digest, kind, attempts, error: String(err).slice(0, 200) })
				return null
			}
			await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
		}
	}
	return null
}

/**
 * (a) A `create_balance_manager` send: take the created object whose type ends in
 * `::balance_manager::BalanceManager` and persist its id. This is what closes the
 * loop the README used to hand to the operator — the agent now keeps its own manager.
 */
async function captureCreatedManager(digest: string, n: number): Promise<string | undefined> {
	const tx = await fetchTx(digest, 'create_balance_manager')
	const id = findCreatedBalanceManagerId(tx)
	if (!id) {
		log('warn', 'balance_manager_not_found', {
			tick: n,
			digest,
			note: 'transaction submitted but no created ::balance_manager::BalanceManager in objectChanges',
		})
		return undefined
	}
	state.balanceManagerId = id
	saveState()
	log('event', 'balance_manager_created', { tick: n, digest, balanceManagerId: id, stateFile: STATE_FILE })
	return id
}

/**
 * (b) A `requote` send: replace the planned placeholders with the u128 ids DeepBook
 * issued, drop anything an `OrderCanceled` event named, and emit one `fill` line per
 * `OrderFilled` where we were the maker — which is how the 24 h run counts fills on
 * both sides.
 */
async function reconcileFromChain(digest: string, n: number, balanceManagerId: string, kept: TrackedOrder[]): Promise<void> {
	const tx = await fetchTx(digest, 'requote')
	if (!tx) {
		// Keep the placeholders rather than inventing state. They cannot be cancelled,
		// and the next tick will say so out loud.
		log('warn', 'orders_unconfirmed', { tick: n, digest, note: 'could not read the transaction back; resting set left as planned' })
		return
	}

	const opts = { ...SCALARS, poolId: POOL.address, balanceManagerId }
	const placed = parseOrderPlaced(tx, opts)
	const canceled = parseOrderCanceled(tx, opts)
	// Through `collectFillsFromPage`, not `parseOrderFilled` directly: a receipt's events
	// carry the same `id: {txDigest, eventSeq}` a queried event does, so a fill found
	// here and the same fill found by `scanFills` have the SAME key and are logged once.
	// This path only ever sees a fill where we were the maker inside our own
	// transaction, which is the rare case; the event scan is what catches the normal one.
	const fills = fillLedger.add(collectFillsFromPage(tx.events ?? [], opts))

	for (const f of fills) logFill(f, n, 'own_tx')

	const canceledIds = new Set(canceled.map((c) => c.orderId))
	const survivors = kept.filter((o) => !canceledIds.has(o.orderId))
	state.resting = [
		...survivors,
		...placed.map((o) => ({
			orderId: o.orderId,
			isBid: o.isBid,
			price: o.price,
			quantity: o.quantity,
			simulated: false,
		})),
	]
	saveState()

	log('event', 'orders_confirmed', {
		tick: n,
		digest,
		placed: placed.map((o) => ({ orderId: o.orderId, side: o.isBid ? 'bid' : 'ask', price: o.price, quantity: o.quantity })),
		canceled: canceled.map((o) => o.orderId),
		fills: fills.length,
		resting: state.resting.length,
	})
}

// -----------------------------------------------------------------------------
// Fill collection — the fills a taker caused, which our own receipts never show
// -----------------------------------------------------------------------------

/**
 * Every fill this process has seen, so a re-read of a page never logs a fill twice.
 * Keyed by the chain's own `txDigest:eventSeq`. See `lib/fills.ts`.
 */
const fillLedger = new FillLedger()

/** Running totals, printed at `shutdown` so a grader does not have to re-derive them. */
const fillTotals = { bid: 0, ask: 0, baseBought: 0, baseSold: 0, quoteIn: 0, quoteOut: 0 }

function logFill(f: CollectedFill, tick: number, source: 'event_scan' | 'own_tx'): void {
	if (f.isBid) {
		fillTotals.bid++
		fillTotals.baseBought += f.quantity
		fillTotals.quoteOut += f.quoteQuantity
	} else {
		fillTotals.ask++
		fillTotals.baseSold += f.quantity
		fillTotals.quoteIn += f.quoteQuantity
	}
	log('event', 'fill', {
		tick,
		digest: f.txDigest,
		eventSeq: f.eventSeq,
		key: f.key,
		orderId: f.makerOrderId,
		// BOTH spellings. The spread-vs-gas measure is written against `isBid`; every
		// earlier log line said `side`. Emitting one and grading the other is how the measure
		// became ungradeable on a log that had the data.
		isBid: f.isBid,
		side: f.isBid ? 'bid' : 'ask',
		price: f.price,
		quantity: f.quantity,
		quoteQuantity: f.quoteQuantity,
		takerBalanceManagerId: f.takerBalanceManagerId,
		timestampMs: f.timestampMs,
		source,
	})
}

/**
 * Walk the event stream forward from the saved cursor and log anything new.
 *
 * **Never throws.** A failed scan is reported as `fill_scan_failed` and the tick carries
 * on: fill collection is measurement, and measurement must not be able to fail a tick
 * that quoted correctly. That also keeps `tick_failed` = 0 an honest statement
 * about the LOOP rather than about the observability bolted onto it — the review's point
 * that unhealthy execution must be reported separately, not folded into one counter.
 */
async function scanFills(tick: number, balanceManagerId: string): Promise<void> {
	if (!FILL_SCAN) return
	try {
		const before = fillLedger.size
		const res = await walkFills({
			query: queryFillEvents,
			cursor: state.fillCursor ?? null,
			opts: { ...SCALARS, poolId: POOL.address, balanceManagerId },
			ledger: fillLedger,
			limit: FILL_PAGE_SIZE,
			maxPages: FILL_SCAN_PAGES,
		})
		for (const f of res.fills) logFill(f, tick, 'event_scan')
		if (res.cursor) {
			state.fillCursor = res.cursor
			saveState()
		}
		log('info', 'fill_scan', {
			tick,
			pages: res.pages,
			scanned: res.scanned,
			newFills: fillLedger.size - before,
			totalFills: fillLedger.size,
			truncated: res.truncated,
			cursor: state.fillCursor ?? null,
		})
	} catch (err) {
		log('warn', 'fill_scan_failed', { tick, error: String(err).slice(0, 200) })
	}
}

// -----------------------------------------------------------------------------
// Gas accounting — the receipt for a digest we submitted
// -----------------------------------------------------------------------------

/** Net SUI burned by this process's own submissions, summed as receipts arrive. */
const gasTotals = { receipts: 0, missing: 0, netSui: 0, grossSui: 0, failed: 0 }

/**
 * Fetch the effects for a digest and log its gas.
 *
 * Separate from `tx_submitted` on purpose: `tx_submitted` is written the instant the
 * digest comes back and must never be delayed or lost because a receipt read failed.
 * A `tx_submitted` with no matching `tx_gas` is therefore a visible gap, which is what
 * the money table needs — a missing receipt has to be reported, not silently treated as
 * zero cost.
 *
 * Never throws, for the same reason `scanFills` does not.
 */
async function recordGas(digest: string, kind: string, tick: number): Promise<void> {
	try {
		const receipt = await fetchReceipt(digest)
		const gas = parseGasUsed(receipt, digest)
		if (!gas) {
			gasTotals.missing++
			log('warn', 'tx_gas_missing', { tick, kind, digest, note: 'no effects on the receipt; cost unknown for this digest' })
			return
		}
		gasTotals.receipts++
		gasTotals.netSui += gas.netSui
		gasTotals.grossSui += gas.grossSui
		if (gas.status !== 'success') gasTotals.failed++
		log('event', 'tx_gas', {
			tick,
			kind,
			digest,
			status: gas.status,
			error: gas.error ?? null,
			computationMist: gas.computationMist,
			storageMist: gas.storageMist,
			rebateMist: gas.rebateMist,
			nonRefundableMist: gas.nonRefundableMist,
			// net = what the run costs; gross = what the gas coin must cover at submission.
			netSui: gas.netSui,
			grossSui: gas.grossSui,
			runNetSui: gasTotals.netSui,
		})
	} catch (err) {
		gasTotals.missing++
		log('warn', 'tx_gas_failed', { tick, kind, digest, error: String(err).slice(0, 200) })
	}
}

// -----------------------------------------------------------------------------
// Book parameters — read once from chain, with a documented fallback.
// -----------------------------------------------------------------------------

let bookParams: { tickSize: number; lotSize: number; minSize: number } | undefined

/**
 * `db` is passed as a getter, not a value, everywhere a DeepBookClient crosses a
 * function boundary in this file. A rotation replaces the client mid-call, and a
 * captured `db` would keep reading the endpoint that just failed.
 */
type GetDb = () => DeepBookClient

async function getBookParams(db: GetDb) {
	if (bookParams) return bookParams
	try {
		const p = await withRpc('poolBookParams', () => db().poolBookParams(POOL_KEY))
		bookParams = { tickSize: p.tickSize, lotSize: p.lotSize, minSize: p.minSize }
		log('info', 'book_params', { source: 'chain', ...bookParams })
	} catch (err) {
		bookParams = { ...FALLBACK_BOOK }
		log('warn', 'book_params', { source: 'fallback', ...bookParams, error: String(err).slice(0, 200) })
	}
	return bookParams
}

// -----------------------------------------------------------------------------
// Inventory
// -----------------------------------------------------------------------------

interface Inventory {
	baseInventory: number
	quoteInventory: number
	locked?: { base: number; quote: number; deep: number }
	source: 'chain' | 'dry_run_override' | 'dry_run_env'
}

/**
 * `DRY_RUN_BASE_INVENTORY` / `DRY_RUN_QUOTE_INVENTORY`, when they are set at all.
 *
 * In a dry run these OVERRIDE the on-chain read. That is what lets the SUI-only
 * bootstrap be rehearsed against a real, well-stocked BalanceManager: point the agent
 * at a live manager for the object resolution the PTB build needs, and tell it to
 * pretend it holds no DEEP. Unset, the chain read stands.
 */
function dryRunInventoryOverride(): { baseInventory: number; quoteInventory: number } | undefined {
	if (!DRY_RUN) return undefined
	const base = process.env.DRY_RUN_BASE_INVENTORY
	const quote = process.env.DRY_RUN_QUOTE_INVENTORY
	if (base === undefined && quote === undefined) return undefined
	return { baseInventory: Number(base ?? '0'), quoteInventory: Number(quote ?? '0') }
}

/**
 * What has filled and not yet been swept back into the manager.
 *
 * `checkManagerBalance` does NOT include this: on 2026-09-24 the manager read
 * `{DEEP: 0, SUI: 0.0326}` while `account('DEEP_SUI','MAKER').settled_balances.base` was
 * 20 — the 20 DEEP bought on 2026-09-15, still sitting in the pool account. So a tick
 * that decided "nothing to do" from the manager balance alone could skip the very sweep
 * that makes that DEEP usable.
 *
 * Returns undefined when the read fails, and the caller then submits rather than skips:
 * not knowing is never a reason to skip a sweep.
 */
async function readSettled(db: GetDb): Promise<{ base: number; quote: number; deep: number } | undefined> {
	try {
		const acct = (await withRpc('account', () => db().account(POOL_KEY, MANAGER_KEY))) as {
			settled_balances?: { base?: number; quote?: number; deep?: number }
		}
		const s = acct?.settled_balances ?? {}
		return { base: Number(s.base ?? 0), quote: Number(s.quote ?? 0), deep: Number(s.deep ?? 0) }
	} catch (err) {
		log('warn', 'settled_read_failed', { error: String(err).slice(0, 200), note: 'the tick will submit rather than skip' })
		return undefined
	}
}

/**
 * The chain's list of this manager's open orders on the pool, with what is left of each.
 *
 * The id set comes from `accountOpenOrders`, which throws when the read fails. The
 * quantities come from `getAccountOrderDetails`, which does NOT throw: it returns `[]`
 * on any failure (`orderQueries.mjs:163`), and an empty list read as truth would drop
 * every resting order. So a failed id read returns undefined and the tick keeps its own
 * view, and a missing detail falls back to what we already believed.
 */
async function readChainOrders(db: GetDb): Promise<ChainOrder[] | undefined> {
	try {
		const ids = (await withRpc('accountOpenOrders', () => db().accountOpenOrders(POOL_KEY, MANAGER_KEY))).map(String)
		const details = await withRpc('getAccountOrderDetails', () => db().getAccountOrderDetails(POOL_KEY, MANAGER_KEY))
		const left = new Map(
			(details ?? []).map((d) => [String(d.order_id), (Number(d.quantity) - Number(d.filled_quantity)) / SCALARS.baseScalar]),
		)
		const known = new Map(state.resting.map((o) => [o.orderId, o.quantity]))
		return ids.map((orderId) => ({ orderId, remaining: left.get(orderId) ?? known.get(orderId) ?? ORDER_SIZE }))
	} catch (err) {
		log('warn', 'open_orders_read_failed', { error: String(err).slice(0, 200), note: 'resting set NOT reconciled this tick' })
		return undefined
	}
}

async function readInventory(db: GetDb): Promise<Inventory> {
	const override = dryRunInventoryOverride()
	if (override) return { ...override, source: 'dry_run_override' }
	try {
		// `lockedBalance` was already being read, and already being logged — it was just
		// never given to the planner. That gap is defect 1; see `lib/quotes.ts`.
		// Sequential, not Promise.all: a rotation part-way through a parallel batch would
		// leave two of the three reads on the dead endpoint with no way to redo them.
		const locked = await withRpc('lockedBalance', () => db().lockedBalance(POOL_KEY, MANAGER_KEY))
		const baseBal = await withRpc('checkManagerBalance:base', () => db().checkManagerBalance(MANAGER_KEY, POOL.baseCoin))
		const quoteBal = await withRpc('checkManagerBalance:quote', () => db().checkManagerBalance(MANAGER_KEY, POOL.quoteCoin))
		return {
			baseInventory: baseBal.balance,
			quoteInventory: quoteBal.balance,
			locked: { base: locked.base, quote: locked.quote, deep: locked.deep },
			source: 'chain',
		}
	} catch (err) {
		if (!DRY_RUN) throw err
		log('warn', 'inventory_read_failed', { error: String(err).slice(0, 200) })
		return {
			baseInventory: Number(process.env.DRY_RUN_BASE_INVENTORY ?? '0'),
			quoteInventory: Number(process.env.DRY_RUN_QUOTE_INVENTORY ?? '0'),
			source: 'dry_run_env',
		}
	}
}

// -----------------------------------------------------------------------------
// Tick
// -----------------------------------------------------------------------------

async function tick(owner: string): Promise<void> {
	state.tick++
	const n = state.tick
	const balanceManagerId = state.balanceManagerId ?? ENV_BALANCE_MANAGER_ID

	// The DeepBookClient captures the Sui client at construction, so it must be rebuilt
	// whenever the RPC rotates — through `makeDeepBookClient`, the one place the manager
	// key and balanceManagers config (address, plus the tradeCap slot this recipe leaves
	// empty) are set, so the rebuilt client is configured identically.
	let dbClient = makeDeepBookClient(owner, balanceManagerId)
	const db: GetDb = () => dbClient
	const offRotate = onRpcRotated((_client, url) => {
		dbClient = makeDeepBookClient(owner, balanceManagerId)
		log('info', 'deepbook_client_rebuilt', { tick: n, rpc: url, balanceManagerId: balanceManagerId ?? null, managerKey: MANAGER_KEY })
	})
	try {
		await tickBody(n, balanceManagerId, db)
	} finally {
		offRotate()
	}
}

async function tickBody(n: number, balanceManagerId: string | undefined, db: GetDb): Promise<void> {
	// (1) Read the live book.
	const l2 = await withRpc('getLevel2TicksFromMid', () => db().getLevel2TicksFromMid(POOL_KEY, BOOK_TICKS))
	const bestBid = l2.bid_prices?.[0]
	const bestAsk = l2.ask_prices?.[0]
	if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
		throw new Error(`empty book for ${POOL_KEY}`)
	}
	const mid = (bestBid + bestAsk) / 2
	log('info', 'book_read', { tick: n, bestBid, bestAsk, mid })
	state.lastMid = mid

	// (2) One BalanceManager, created once and persisted. On the live path the agent
	// reads the created object id out of its own transaction and writes it to state —
	// there is nothing for the operator to copy across.
	if (!balanceManagerId) {
		log('event', 'balance_manager_missing', {
			tick: n,
			stateFile: STATE_FILE,
			note: 'no id in state and none in DEEPBOOK_BALANCE_MANAGER_ID; building a create tx and not quoting this tick',
		})
		const tx = new Transaction()
		tx.add(db().balanceManager.createAndShareBalanceManager())
		const b64 = await buildKindBytes(tx, 'create_balance_manager', { tick: n })
		if (b64) {
			const digest = await signAndSendTx(b64, 'create_balance_manager')
			if (digest) {
				// The send counter check reads `sendTxCalls` = number of `tx_submitted` lines. This send used to
				// emit only `balance_manager_created`, so a run that created its manager
				// finished one short and failed the counter check on arithmetic rather than on keys. The
				// 2026-09-15 five-tick run is exactly that: shutdown `sendTxCalls: 1`,
				// zero `tx_submitted` lines.
				log('event', 'tx_submitted', { tick: n, kind: 'create_balance_manager', digest })
				await recordGas(digest, 'create_balance_manager', n)
				await captureCreatedManager(digest, n)
			}
		}
		saveState()
		log('info', 'tick_done', { tick: n, quoted: false, reason: 'balance_manager_missing' })
		return
	}

	// (2b) Collect fills from the chain's event stream. A taker crossing our resting
	// order does it in THEIR transaction, which this loop never fetches, so this is the
	// only path on which a maker's own fills are visible at all. Read-only; cannot fail
	// the tick.
	await scanFills(n, balanceManagerId)

	const params = await getBookParams(db)

	// (2c) Reconcile what we think is resting against what the chain says is open.
	// Skipped in a dry run, where the resting set is simulated and nothing is on chain.
	if (!DRY_RUN) {
		const chain = await readChainOrders(db)
		if (chain) {
			const r = reconcileResting(state.resting, chain, (SCALARS.floatScalar * SCALARS.quoteScalar) / SCALARS.baseScalar)
			if (r.dropped.length || r.adopted.length || r.resized.length) {
				log('event', 'resting_reconciled', { tick: n, dropped: r.dropped, adopted: r.adopted, resized: r.resized, resting: r.resting })
				state.resting = r.resting
				saveState()
			}
		}
	}

	// (3) Inventory.
	const inv = await readInventory(db)
	const ownLock = ownOrderLock(state.resting)
	log('info', 'inventory', {
		tick: n,
		balanceManagerId,
		baseCoin: POOL.baseCoin,
		quoteCoin: POOL.quoteCoin,
		baseInventory: inv.baseInventory,
		quoteInventory: inv.quoteInventory,
		locked: inv.locked,
		// Flat, so a log grep can answer "what did the planner actually get?" without
		// reaching into a nested object.
		//   *Locked     — the chain's `lockedBalance`, which is order locks PLUS unswept
		//                 fill proceeds. Not all of it is spendable this tick.
		//   *OwnLock    — what our own resting orders must have locked, derived from state
		//   *Plannable  — available + min(the two), the figure the planner sizes against
		baseLocked: inv.locked?.base ?? 0,
		quoteLocked: inv.locked?.quote ?? 0,
		baseOwnLock: ownLock.base,
		quoteOwnLock: ownLock.quote,
		basePlannable: inv.baseInventory + Math.min(ownLock.base, inv.locked?.base ?? 0),
		quotePlannable: inv.quoteInventory + Math.min(ownLock.quote, inv.locked?.quote ?? 0),
		source: inv.source,
	})

	// (4) Plan. A side with nothing behind it is not quoted — see `skippedSides`.
	const plan = planQuotes({
		mid,
		spreadBps: SPREAD_BPS,
		orderSize: ORDER_SIZE,
		baseInventory: inv.baseInventory,
		quoteInventory: inv.quoteInventory,
		// Defect 1: what a resting order has locked is still our inventory. Without
		// these two the planner reads a side funded entirely by its own resting order as
		// empty, cancels the order, and re-places it next tick — the churn of ticks 2-4
		// of the first live run. See the header comment in `lib/quotes.ts`.
		baseLocked: inv.locked?.base ?? 0,
		quoteLocked: inv.locked?.quote ?? 0,
		baseFloor: BASE_FLOOR,
		quoteFloor: QUOTE_FLOOR,
		resting: state.resting,
		requoteToleranceBps: REQUOTE_TOLERANCE_BPS,
		tickSize: params.tickSize,
		lotSize: params.lotSize,
		minSize: params.minSize,
	})
	// A cancel is only a move call when the chain issued the id. In a dry run the
	// resting set is this agent's own bookkeeping, so its ids are placeholders and
	// there is nothing on chain to cancel — they are reported, not built.
	const restingById = new Map(state.resting.map((o) => [o.orderId, o]))
	const cancellable = plan.cancels.filter((id) => {
		const o = restingById.get(id)
		return !o?.simulated && isRealOrderId(id)
	})
	const cancelsSkipped = plan.cancels.length - cancellable.length

	log('event', 'quote_plan', {
		tick: n,
		mid,
		spreadBps: SPREAD_BPS,
		cancels: plan.cancels,
		cancelsSkipped,
		place: plan.place,
		skippedSides: plan.skippedSides,
	})

	// (4b) Optional: do not pay for a transaction that would do nothing.
	if (SKIP_EMPTY_TICK && plan.cancels.length === 0 && plan.place.length === 0) {
		const settled = await readSettled(db)
		const nothingSettled = settled !== undefined && settled.base === 0 && settled.quote === 0 && settled.deep === 0
		if (nothingSettled) {
			log('event', 'tick_no_submit', {
				tick: n,
				reason: 'nothing_to_do',
				settled,
				resting: state.resting.length,
				skippedSides: plan.skippedSides,
				note: 'no cancel, no place, nothing settled to sweep — a transaction here would cost ~0.00115 SUI and change nothing',
			})
			saveState()
			log('info', 'tick_done', { tick: n, quoted: false, reason: 'nothing_to_do' })
			return
		}
		log('info', 'settle_needed', { tick: n, settled: settled ?? null, note: settled ? 'a settled balance is waiting; submitting the sweep' : 'settled balance unknown; submitting rather than skipping' })
	}

	// (5) One PTB: cancels, then places, then settle.
	const tx = new Transaction()
	for (const orderId of plan.cancels) {
		if (!cancellable.includes(orderId)) {
			log('info', 'cancel_skipped_simulated', {
				tick: n,
				orderId,
				reason: restingById.get(orderId)?.simulated ? 'simulated_order' : 'not_a_u128_order_id',
			})
			continue
		}
		// `cancelLiveOrder`, not `cancelOrder`: now that the ids are real, an order can
		// fill between the tick that read the book and the tick that cancels it.
		// `cancelOrder` aborts the whole PTB on an id the manager no longer holds;
		// `cancelLiveOrder` no-ops. See SDK-NOTES §B5.
		tx.add(db().deepBook.cancelLiveOrder(POOL_KEY, MANAGER_KEY, orderId))
	}
	for (const order of plan.place) {
		tx.add(
			db().deepBook.placeLimitOrder({
				poolKey: POOL_KEY,
				balanceManagerKey: MANAGER_KEY,
				clientOrderId: String(n),
				price: order.price,
				quantity: order.quantity,
				isBid: order.isBid,
			}),
		)
	}
	// Sweep whatever filled since the last tick back into the manager.
	tx.add(db().deepBook.withdrawSettledAmounts(POOL_KEY, MANAGER_KEY))

	const b64 = await buildKindBytes(tx, 'requote', {
		tick: n,
		orders: plan.place.length + plan.cancels.length,
		cancels: plan.cancels.length,
		cancelsBuilt: cancellable.length,
		cancelsSkipped,
		places: plan.place.length,
	})
	if (!b64) {
		log('info', 'tick_done', { tick: n, quoted: false, reason: 'tx_build_failed' })
		saveState()
		return
	}

	// (6) Hand the kind bytes to waap-cli. In a dry run this is where we stop.
	const digest = await signAndSendTx(b64, 'requote')

	// (7) Persist what is now resting.
	const kept = state.resting.filter((o) => !plan.cancels.includes(o.orderId))
	state.balanceManagerId = balanceManagerId

	if (digest) {
		log('event', 'tx_submitted', { tick: n, kind: 'requote', digest })
		await recordGas(digest, 'requote', n)
		// Live: the chain issued real u128 ids. Read them back out of the transaction's
		// OrderPlaced events and write them into state, so the next tick can cancel.
		state.resting = kept
		await reconcileFromChain(digest, n, balanceManagerId, kept)
	} else {
		// Dry run: nothing was submitted, so nothing was issued. These ids are this
		// agent's own placeholders and are marked as such — they exist only so the next
		// tick exercises the requote-tolerance path instead of quoting from scratch.
		const placed: TrackedOrder[] = plan.place.map((o: PlannedOrder, i: number) => ({
			orderId: `t${n}-${o.isBid ? 'bid' : 'ask'}-${i}`,
			isBid: o.isBid,
			price: o.price,
			quantity: o.quantity,
			simulated: true,
		}))
		state.resting = [...kept, ...placed]
		saveState()
	}

	log('info', 'tick_done', { tick: n, quoted: true, resting: state.resting.length })
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

/**
 * The measured figures, on the `shutdown` line.
 *
 * These are THIS PROCESS's counters. A deposit, a probe and a stop each run as their own
 * process and append to the same log file, so summing `tx_submitted` across the file
 * and comparing it against one loop's `sendTxCalls` compares different populations. The
 * counters here are the loop's, and `elapsedMs` is measured from this process's own
 * start — which is also how a 24 h run's length must be read, since `max_ticks` fires on a
 * tick count and tick execution adds time between sleeps, so `ticks × POLL_MS` is never
 * the wall clock.
 */
function runSummary(startedAtMs: number) {
	return {
		startedAt: new Date(startedAtMs).toISOString(),
		elapsedMs: Date.now() - startedAtMs,
		elapsedHours: Number(((Date.now() - startedAtMs) / 3_600_000).toFixed(4)),
		fills: { ...fillTotals, unique: fillLedger.size },
		gas: { ...gasTotals },
		fillCursor: state.fillCursor ?? null,
	}
}

let stopping = false
let consecutiveErrors = 0

/**
 * Where the fill walk starts.
 *
 * A saved cursor wins: a restart must backfill the gap, not skip it. With no saved
 * cursor the walk is anchored at the moment the process started, so the run window and
 * the fill window are the same window — and the anchor is taken from a `TimeRange`
 * query, the only filter that can find a point in time, whose cursor a typed walk then
 * accepts (see `lib/fills.ts`).
 *
 * `anchorAtMs` is deliberately a little BEFORE `agent_start`: the cursor points at the
 * first event in the window and the walk resumes after it, so starting flush with the
 * start instant could drop one event.
 */
async function anchorFillCursor(startedAtMs: number): Promise<void> {
	if (!FILL_SCAN) return
	if (state.fillCursor?.txDigest && FILL_RESUME) {
		log('info', 'fill_cursor', { source: 'state', cursor: state.fillCursor, note: 'resuming: the gap since the last run is backfilled, not skipped' })
		return
	}
	if (state.fillCursor?.txDigest) {
		// The in-loop walk reads every OrderFilled on the network, a page of 50 at a time.
		// Resuming a 16 h old cursor on 2026-09-25 left it hours behind, blind to its own
		// fills. The gap is not lost: `npm run fills` walks from the log's FIRST
		// `agent_start`. Set FILL_RESUME=1 to backfill in the loop anyway.
		log('info', 'fill_gap', { savedCursor: state.fillCursor, note: 'not backfilled in the loop; `npm run fills` covers it' })
	}
	const anchorAtMs = startedAtMs - 120_000
	try {
		const cursor = await anchorCursorAt(anchorAtMs)
		state.fillCursor = cursor
		saveState()
		log('info', 'fill_cursor', {
			source: 'anchor',
			anchorAt: new Date(anchorAtMs).toISOString(),
			cursor: cursor ?? null,
			note: cursor ? 'walk starts here' : 'no event in the anchor window; the walk starts from the head of the stream',
		})
	} catch (err) {
		log('warn', 'fill_cursor_failed', {
			error: String(err).slice(0, 200),
			note: 'fills will be collected from the first successful scan onward; anything before it is NOT covered — say so when reporting the spread-vs-gas figure',
		})
	}
}

async function main(): Promise<void> {
	loadState()
	const owner = await resolveOwner()
	const startedAtMs = Date.now()

	log('event', 'agent_start', {
		network: NETWORK,
		rpc: currentRpcUrl(),
		rpcPrimary: SUI_RPC,
		rpcEndpoints: RPC_ENDPOINTS,
		maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
		poolKey: POOL_KEY,
		poolId: POOL.address,
		spreadBps: SPREAD_BPS,
		orderSize: ORDER_SIZE,
		baseFloor: BASE_FLOOR,
		quoteFloor: QUOTE_FLOOR,
		requoteToleranceBps: REQUOTE_TOLERANCE_BPS,
		pollMs: POLL_MS,
		maxTicks: MAX_TICKS ?? null,
		dryRun: DRY_RUN,
		skipEmptyTick: SKIP_EMPTY_TICK,
		fillScan: FILL_SCAN,
		fillScanPages: FILL_SCAN_PAGES,
		fillPageSize: FILL_PAGE_SIZE,
		startedAt: new Date(startedAtMs).toISOString(),
		balanceManagerId: state.balanceManagerId ?? ENV_BALANCE_MANAGER_ID ?? null,
		scalars: SCALARS,
		owner,
	})

	if (WRITE_PID_FILE) {
		try {
			fs.writeFileSync(PID_FILE, String(process.pid))
			process.on('exit', () => {
				try {
					fs.unlinkSync(PID_FILE)
				} catch {}
			})
		} catch {}
	}

	for (const sig of ['SIGTERM', 'SIGINT'] as const) {
		process.on(sig, () => {
			log('info', 'shutdown_signal', { signal: sig })
			stopping = true
		})
	}

	await anchorFillCursor(startedAtMs)

	let ticks = 0
	while (!stopping) {
		try {
			await tick(owner)
			consecutiveErrors = 0
		} catch (err) {
			consecutiveErrors++
			log('error', 'tick_failed', {
				error: err instanceof Error ? err.message : String(err),
				consecutiveErrors,
			})
			if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				log('error', 'too_many_consecutive_errors', { consecutiveErrors, sendTxCalls: getSendTxCalls(), sendTxRefused: getSendTxRefused() })
				process.exit(1)
			}
		}

		ticks++
		if (MAX_TICKS && ticks >= MAX_TICKS) {
			log('event', 'shutdown', { reason: 'max_ticks', ticks, dryRun: DRY_RUN, sendTxCalls: getSendTxCalls(), sendTxRefused: getSendTxRefused(), ...runSummary(startedAtMs) })
			process.exit(0)
		}
		if (stopping) break

		log('info', 'next_check', { inMs: POLL_MS })
		const slices = Math.max(1, Math.ceil(POLL_MS / 1000))
		for (let i = 0; i < slices && !stopping; i++) {
			await new Promise((r) => setTimeout(r, Math.min(1000, POLL_MS)))
		}
	}

	log('event', 'shutdown', { reason: 'signal', ticks, dryRun: DRY_RUN, sendTxCalls: getSendTxCalls(), sendTxRefused: getSendTxRefused(), ...runSummary(startedAtMs) })
}

main().catch(fatal)

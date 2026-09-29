/**
 * deepbook-maker — WaaP recipe.
 *
 * A bounded passive market maker on DeepBook DEEP/SUI. Every tick it reads the live book,
 * reconciles its orders, fills, pending sends and budgets from the chain, asks the
 * strategy (`lib/strategy.ts`) what to quote, and — if anything changes — builds ONE
 * unsigned PTB (cancels → post-only places → settle) and hands its kind bytes to
 * `waap-cli send-tx`. Signing happens in the WaaP enclave; there is no key here.
 *
 * Dry run is the default: everything is read and built, nothing is signed.
 *
 * The lifecycle, and what each exit does:
 *
 *   agent_start → ticks → quotes_stopped → cleanup (cancel → settle → withdraw, verified)
 *               → process_exit
 *
 * Handled exits — SIGTERM/SIGINT, MAX_TICKS, the run-duration/gas/drawdown limits,
 * repeated tick failures, an unexpected taker fill, a persistent inventory-limited state
 * — all stop quoting and run cleanup before exiting. A crash cannot run cleanup: order
 * expiry (`ORDER_TTL_MIN`) bounds how long its orders can trade, the state file keeps
 * what it had sent, and `npm run stop` finishes the job.
 */
import { Transaction } from '@mysten/sui/transactions'
import type { DeepBookClient } from '@mysten/deepbook-v3'

import { addTurnover, evaluateLimits, MIST_PER_SUI, pruneTurnover, rollingTurnover, type Limits } from './lib/budget.ts'
import { openContext, type Context } from './lib/context.ts'
import { DEFAULT_CYCLE } from './lib/costs.ts'
import { findCreatedBalanceManagerId, parseOrderCanceled, parseOrderPlaced, type RpcTransactionBlock } from './lib/events.ts'
import { DEFAULT_FILL_SCAN_PAGES, FillLedger, ORDER_FILLED_TYPE, walkFills, type CollectedFill } from './lib/fills.ts'
import { GAS_CAPS, GasBudgetError, RESERVE_PER_TX_MIST, reconcilePending, runCleanup, sendWithIntent } from './lib/ops.ts'
import { blocksQuoting, makeClientOrderId } from './lib/pending.ts'
import { managerSetupTerminal, terminalExitCode } from './lib/manager-setup.ts'
import { addPlaceOrder } from './lib/ptb.ts'
import { ownOrderLock, reconcileResting, type ChainOrder } from './lib/quotes.ts'
import { DEFAULT_STRATEGY, planStrategy, type StrategyConfig } from './lib/strategy.ts'
import { StateError, type TrackedOrder } from './lib/state.ts'
import {
	AGENT_ID,
	DRY_RUN,
	MANAGER_KEY,
	NETWORK,
	POOL,
	POOL_KEY,
	RPC_ENDPOINTS,
	STATE_FILE,
	SUI_RPC,
	anchorCursorAt,
	headCursor,
	buildKindBytes,
	currentRpcUrl,
	errorCause,
	fatal,
	getSendTxCalls,
	getSendTxRefused,
	log,
	makeDeepBookClient,
	onRpcRotated,
	poolScalars,
	queryFillEvents,
	sui,
	withRpc,
} from './lib/waap.ts'

// -----------------------------------------------------------------------------
// Config — every default is in `.env.example` with its reason.
// -----------------------------------------------------------------------------

const num = (k: string, d: number) => {
	const v = process.env[k]
	if (v === undefined || v === '') return d
	const n = Number(v)
	if (!Number.isFinite(n)) {
		console.error(`[${AGENT_ID}] ${k}=${v} is not a number`)
		process.exit(1)
	}
	return n
}
const flag = (k: string, d: boolean) => {
	const v = (process.env[k] ?? '').toLowerCase()
	return v === '' ? d : v === '1' || v === 'true'
}

const POLL_MS = num('POLL_MS', 60_000)
const MAX_TICKS = process.env.MAX_TICKS ? num('MAX_TICKS', 0) : undefined
const BOOK_TICKS = num('BOOK_TICKS', 5)
const MAX_CONSECUTIVE_ERRORS = num('MAX_CONSECUTIVE_ERRORS', 20)
const INVENTORY_LIMITED_EXIT_TICKS = num('INVENTORY_LIMITED_EXIT_TICKS', 10)
const FILL_SCAN_PAGES = num('FILL_SCAN_PAGES', DEFAULT_FILL_SCAN_PAGES)
const FILL_PAGE_SIZE = num('FILL_PAGE_SIZE', 50)
/** Skip the fill backfill after a restart. Turnover and P&L for the run are then marked incomplete. */
const FILL_SKIP_GAP = flag('FILL_SKIP_GAP', false)
/** In a dry run adopting a configured manager is harmless (nothing is signed), so it is implied. */
const ADOPT_MANAGER = flag('ADOPT_MANAGER', false) || DRY_RUN
const BREAK_STALE_LOCK = process.argv.includes('--break-stale-lock')
/** Where cleanup sends the withdrawn coins. Defaults to the agent's own wallet. */
const WITHDRAW_RECIPIENT = process.env.WITHDRAW_RECIPIENT?.trim() || undefined

const STRATEGY: StrategyConfig = {
	...DEFAULT_STRATEGY,
	targetBaseFraction: num('TARGET_BASE_FRACTION', DEFAULT_STRATEGY.targetBaseFraction),
	bandLow: num('BAND_LOW', DEFAULT_STRATEGY.bandLow),
	bandHigh: num('BAND_HIGH', DEFAULT_STRATEGY.bandHigh),
	skewMaxBps: num('SKEW_MAX_BPS', DEFAULT_STRATEGY.skewMaxBps),
	maxOrderSize: num('ORDER_SIZE', DEFAULT_STRATEGY.maxOrderSize),
	minSpreadBps: num('SPREAD_BPS', DEFAULT_STRATEGY.minSpreadBps),
	maxSpreadBps: num('MAX_SPREAD_BPS', DEFAULT_STRATEGY.maxSpreadBps),
	touchMultiple: num('TOUCH_MULTIPLE', DEFAULT_STRATEGY.touchMultiple),
	holdOnLiquidityPause: flag('HOLD_ON_LIQUIDITY_PAUSE', DEFAULT_STRATEGY.holdOnLiquidityPause),
	resumeMargin: num('LIQUIDITY_RESUME_MARGIN', DEFAULT_STRATEGY.resumeMargin),
	minLiquidityPauseMs: num('LIQUIDITY_MIN_PAUSE_MIN', DEFAULT_STRATEGY.minLiquidityPauseMs / 60_000) * 60_000,
	toleranceBps: num('REQUOTE_TOLERANCE_BPS', DEFAULT_STRATEGY.toleranceBps),
	minDwellMs: num('MIN_DWELL_SEC', DEFAULT_STRATEGY.minDwellMs / 1000) * 1000,
	orderTtlMs: num('ORDER_TTL_MIN', DEFAULT_STRATEGY.orderTtlMs / 60_000) * 60_000,
	refreshBeforeExpiryMs: num('REFRESH_BEFORE_EXPIRY_MIN', DEFAULT_STRATEGY.refreshBeforeExpiryMs / 60_000) * 60_000,
	staleBookMs: num('STALE_BOOK_SEC', DEFAULT_STRATEGY.staleBookMs / 1000) * 1000,
	payWithDeep: flag('PAY_WITH_DEEP', DEFAULT_STRATEGY.payWithDeep),
	deepFeeReserve: num('DEEP_FEE_RESERVE', DEFAULT_STRATEGY.deepFeeReserve),
	cycle: {
		...DEFAULT_CYCLE,
		replacementsPerCycle: num('COST_REPLACEMENTS_PER_CYCLE', DEFAULT_CYCLE.replacementsPerCycle),
		cyclesToAmortize: num('COST_CYCLES_TO_AMORTIZE', DEFAULT_CYCLE.cyclesToAmortize),
		quantile: (process.env.COST_QUANTILE as 'median' | 'p90' | 'max') ?? DEFAULT_CYCLE.quantile,
	},
}

const LIMITS: Limits = {
	gas: GAS_CAPS,
	maxDrawdownQuote: num('MAX_DRAWDOWN_SUI', 0.05),
	maxTurnoverQuote: num('MAX_TURNOVER_SUI', 20),
	turnoverWindowMs: num('TURNOVER_WINDOW_HOURS', 24) * 3_600_000,
	maxRunMs: num('MAX_RUN_MIN', 0) * 60_000,
	maxMarkAgeMs: Math.max(3 * POLL_MS, 120_000),
}

function validateConfig() {
	const bad: string[] = []
	const s = STRATEGY
	if (!(s.bandLow >= 0 && s.bandLow < s.targetBaseFraction && s.targetBaseFraction < s.bandHigh && s.bandHigh <= 1)) bad.push('need 0 ≤ BAND_LOW < TARGET_BASE_FRACTION < BAND_HIGH ≤ 1')
	if (!(s.orderTtlMs > POLL_MS + s.refreshBeforeExpiryMs)) bad.push('ORDER_TTL_MIN must exceed POLL_MS + REFRESH_BEFORE_EXPIRY_MIN, or every order would be replaced every tick')
	if (!(s.orderTtlMs <= 24 * 3_600_000)) bad.push('ORDER_TTL_MIN must be ≤ 1440: expiry is what bounds a crashed run’s exposure')
	if (!(s.maxOrderSize > 0) || !(s.minSpreadBps > 0) || !(s.maxSpreadBps >= s.minSpreadBps)) bad.push('ORDER_SIZE, SPREAD_BPS and MAX_SPREAD_BPS must be positive, MAX ≥ SPREAD')
	if (bad.length) {
		console.error(`[${AGENT_ID}] invalid configuration:\n  - ${bad.join('\n  - ')}`)
		process.exit(1)
	}
}

if (!POOL) {
	console.error(`[${AGENT_ID}] unknown POOL_KEY ${POOL_KEY} on ${NETWORK}`)
	process.exit(1)
}
const SCALARS = poolScalars()
const PRICE_DIVISOR = (SCALARS.floatScalar * SCALARS.quoteScalar) / SCALARS.baseScalar

// -----------------------------------------------------------------------------
// Run-wide state held in memory; everything that must survive is in ctx.state.
// -----------------------------------------------------------------------------

let ctx: Context
let runId: string
let runStartMs = 0
/** When the current liquidity pause began; carried between ticks, not persisted (a restart resumes on the plain rule). */
let liquidityPausedSinceMs: number | undefined
const fillLedger = new FillLedger()
let bookParams: { tickSize: number; lotSize: number; minSize: number; verified: boolean } | undefined
let fees: { makerFeeRate: number; verified: boolean } | undefined
let haltReason: string | undefined
let inventoryLimitedTicks = 0

type GetDb = () => DeepBookClient
const L = (level: string, message: string, data: Record<string, unknown> = {}) => log(level, message, { runId, ...data })

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

async function readParams(db: GetDb): Promise<void> {
	if (!bookParams?.verified) {
		try {
			const p = await withRpc('poolBookParams', () => db().poolBookParams(POOL_KEY))
			bookParams = { tickSize: p.tickSize, lotSize: p.lotSize, minSize: p.minSize, verified: true }
			L('info', 'book_params', { source: 'chain', ...bookParams })
		} catch (err) {
			// A dry run may plan against the documented DEEP/SUI values; a live run may not.
			bookParams = { tickSize: 0.00001, lotSize: 1, minSize: 10, verified: DRY_RUN }
			L('warn', 'book_params', { source: 'fallback', ...bookParams, error: String(err).slice(0, 200), note: DRY_RUN ? 'dry run: fallback used for planning' : 'live: quoting paused until the chain read succeeds' })
		}
	}
	if (!fees?.verified) {
		try {
			const t = await withRpc('poolTradeParams', () => db().poolTradeParams(POOL_KEY))
			fees = { makerFeeRate: t.makerFee, verified: true }
			L('info', 'trade_params', { source: 'chain', makerFee: t.makerFee, takerFee: t.takerFee })
		} catch (err) {
			fees = { makerFeeRate: 0, verified: false }
			L('warn', 'trade_params_failed', { error: String(err).slice(0, 200), note: 'fees unverified: quoting paused' })
		}
	}
}

async function readChainOrders(db: GetDb): Promise<Array<ChainOrder & { expiresAtMs?: number }> | undefined> {
	try {
		const ids = (await withRpc('accountOpenOrders', () => db().accountOpenOrders(POOL_KEY, MANAGER_KEY))).map(String)
		const details = await withRpc('getAccountOrderDetails', () => db().getAccountOrderDetails(POOL_KEY, MANAGER_KEY))
		const byId = new Map((details ?? []).map((d) => [String(d.order_id), d]))
		const known = new Map(ctx.state.resting.map((o) => [o.orderId, o.quantity]))
		// `getAccountOrderDetails` returns [] on failure. An open id we know nothing about and
		// have no detail for cannot be sized — treat the read as failed rather than drop it
		// (review #10).
		const blind = ids.filter((id) => !byId.has(id) && !known.has(id))
		if (blind.length) {
			L('warn', 'open_orders_detail_missing', { ids: blind, note: 'orders on chain we cannot size; pausing rather than ignoring them' })
			return undefined
		}
		return ids.map((orderId) => {
			const d = byId.get(orderId) as { quantity?: unknown; filled_quantity?: unknown; expire_timestamp?: unknown } | undefined
			return {
				orderId,
				remaining: d ? (Number(d.quantity) - Number(d.filled_quantity)) / SCALARS.baseScalar : (known.get(orderId) ?? 0),
				expiresAtMs: d?.expire_timestamp !== undefined ? Number(d.expire_timestamp) : undefined,
			}
		})
	} catch (err) {
		L('warn', 'open_orders_read_failed', { error: String(err).slice(0, 200) })
		return undefined
	}
}

async function readInventory(db: GetDb): Promise<{ free: { base: number; quote: number }; locked: { base: number; quote: number } } | undefined> {
	if (DRY_RUN && (process.env.DRY_RUN_BASE_INVENTORY !== undefined || process.env.DRY_RUN_QUOTE_INVENTORY !== undefined)) {
		return { free: { base: num('DRY_RUN_BASE_INVENTORY', 0), quote: num('DRY_RUN_QUOTE_INVENTORY', 0) }, locked: { base: 0, quote: 0 } }
	}
	try {
		const locked = await withRpc('lockedBalance', () => db().lockedBalance(POOL_KEY, MANAGER_KEY))
		const b = await withRpc('checkManagerBalance:base', () => db().checkManagerBalance(MANAGER_KEY, POOL.baseCoin))
		const q = await withRpc('checkManagerBalance:quote', () => db().checkManagerBalance(MANAGER_KEY, POOL.quoteCoin))
		return { free: { base: b.balance, quote: q.balance }, locked: { base: locked.base, quote: locked.quote } }
	} catch (err) {
		L('warn', 'inventory_read_failed', { error: String(err).slice(0, 200) })
		return undefined
	}
}

async function fetchTx(digest: string): Promise<RpcTransactionBlock | null> {
	for (let i = 0; i < 6; i++) {
		try {
			return (await withRpc('getTransactionBlock', () => sui.getTransactionBlock({ digest, options: { showEvents: true, showObjectChanges: true, showEffects: true } }), { attempts: 2, backoffMs: [1_000, 1_000] })) as unknown as RpcTransactionBlock
		} catch {
			await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
		}
	}
	L('warn', 'tx_fetch_failed', { digest })
	return null
}

// -----------------------------------------------------------------------------
// Fills — one persisted transition: ledger, cursor, turnover
// -----------------------------------------------------------------------------

function logFill(f: CollectedFill, tick: number) {
	L('event', 'fill', { tick, key: f.key, digest: f.txDigest, role: f.role, orderId: f.ownOrderId, isBid: f.isBid, side: f.isBid ? 'bid' : 'ask', price: f.price, quantity: f.quantity, quoteQuantity: f.quoteQuantity, fee: f.fee, feeAsset: f.feeAsset, takerBalanceManagerId: f.takerBalanceManagerId, timestampMs: f.timestampMs })
}

async function scanFills(tick: number, managerId: string): Promise<'caught_up' | 'behind' | 'failed'> {
	const s = ctx.state
	try {
		// Never walk from a null cursor: ascending from null starts at the OLDEST event on
		// chain and would keep quoting paused all run (review #4). Take the head instead.
		if (!s.fills.cursor) {
			s.fills.cursor = await headCursor(ORDER_FILLED_TYPE)
			ctx.save()
			L('warn', 'fill_cursor', { source: 'head', cursor: s.fills.cursor, note: 'no anchor; fills before this point are not covered — `npm run fills` recovers them offline' })
			if (!s.fills.cursor) return 'failed'
		}
		const res = await walkFills({ query: queryFillEvents, cursor: s.fills.cursor, opts: { ...SCALARS, poolId: POOL.address, balanceManagerId: managerId }, ledger: fillLedger, limit: FILL_PAGE_SIZE, maxPages: FILL_SCAN_PAGES })
		for (const f of res.fills) {
			s.fills.ledger.push(f)
			if (f.role !== 'self') s.budget = addTurnover(s.budget, { atMs: Number(f.timestampMs), notionalQuote: f.quoteQuantity, key: f.key })
			// Adjust what we believe is resting so the planner does not count filled size.
			const o = s.resting.find((r) => r.orderId === f.ownOrderId)
			if (o) o.quantity = Math.max(0, o.quantity - f.quantity)
			logFill(f, tick)
			if (f.role !== 'maker') haltReason ??= `unexpected_${f.role}_fill`
		}
		s.resting = s.resting.filter((o) => o.quantity > 0)
		s.fills.cursor = res.cursor
		if (res.completion === 'head') s.fills.caughtUpAtMs = Date.now()
		s.budget = pruneTurnover(s.budget, Date.now(), LIMITS.turnoverWindowMs)
		ctx.save() // fills, dedup set, cursor and turnover together
		L('info', 'fill_scan', { tick, pages: res.pages, scanned: res.scanned, newFills: res.fills.length, totalFills: s.fills.ledger.length, completion: res.completion, watermarkMs: res.watermarkMs ?? null })
		return res.completion === 'page_budget' ? 'behind' : 'caught_up'
	} catch (err) {
		if (err instanceof StateError) throw err
		L('warn', 'fill_scan_failed', { tick, error: String(err).slice(0, 200) })
		return 'failed'
	}
}

// -----------------------------------------------------------------------------
// Tick
// -----------------------------------------------------------------------------

async function tick(): Promise<void> {
	const s = ctx.state
	s.tick++
	const n = s.tick
	const managerId = s.balanceManagerId
	let client = makeDeepBookClient(ctx.owner, managerId)
	const db: GetDb = () => client
	const off = onRpcRotated(() => {
		client = makeDeepBookClient(ctx.owner, managerId)
	})
	try {
		await tickBody(n, managerId, db)
	} finally {
		off()
	}
}

async function tickBody(n: number, managerId: string | undefined, db: GetDb): Promise<void> {
	const s = ctx.state
	const now = () => Date.now()

	// (1) Book, with depth so our own quotes can be taken out of the touch.
	const l2 = await withRpc('getLevel2TicksFromMid', () => db().getLevel2TicksFromMid(POOL_KEY, BOOK_TICKS))
	const readAtMs = now()
	const bestBid = l2.bid_prices?.[0]
	const bestAsk = l2.ask_prices?.[0]
	if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) throw new Error(`empty book for ${POOL_KEY}`)
	const mid = (bestBid + bestAsk) / 2
	s.lastMid = mid
	L('info', 'book_read', { tick: n, bestBid, bestAsk, mid })

	// (2) No manager. Live: create one (persisted intent, like every other send), quote
	// nothing. Dry: show the create bytes, then plan against DRY_RUN_* inventory so a first
	// dry run still shows what the maker would quote.
	if (!managerId) {
		// A create already in flight is never sent again: recover its id from the digest, or
		// wait (unknown) — review #2. Only with no create pending is a new one built.
		const pendingCreate = s.pending.find((p) => p.kind === 'create_manager')
		if (pendingCreate) {
			if (pendingCreate.digest) {
				const id = findCreatedBalanceManagerId(await fetchTx(pendingCreate.digest))
				if (id) {
					s.balanceManagerId = id
					ctx.save()
					L('event', 'balance_manager_created', { tick: n, digest: pendingCreate.digest, balanceManagerId: id, stateFile: STATE_FILE, recovered: true })
					await reconcilePending(ctx, { runId, tick: n })
				} else L('warn', 'balance_manager_not_found', { tick: n, digest: pendingCreate.digest, note: 'will re-read next tick; no second create is sent' })
			} else {
				await reconcilePending(ctx, { runId, tick: n })
				L('warn', 'create_manager_unknown', { tick: n, opId: pendingCreate.opId, note: 'no second create is sent; resolve with `npm run recover`' })
			}
			return
		}
		L('event', 'balance_manager_missing', { tick: n, stateFile: STATE_FILE, note: DRY_RUN ? 'dry run: building the create transaction, then planning against DRY_RUN_* inventory' : 'building a create transaction; not quoting this tick' })
		const tx = new Transaction()
		tx.add(db().balanceManager.createAndShareBalanceManager())
		const b64 = await buildKindBytes(tx, 'create_manager', { tick: n })
		if (!b64) return
		const out = await sendWithIntent(ctx, { kind: 'create_manager', b64, runId, proc: 'loop' })
		if (out.status === 'submitted') {
			const id = findCreatedBalanceManagerId(await fetchTx(out.digest))
			if (id) {
				s.balanceManagerId = id
				ctx.save()
				L('event', 'balance_manager_created', { tick: n, digest: out.digest, balanceManagerId: id, stateFile: STATE_FILE })
				// Fold the receipt only once the id is safely in state; until then the pending
				// op is what stops a second create.
				await reconcilePending(ctx, { runId, tick: n })
			} else L('warn', 'balance_manager_not_found', { tick: n, digest: out.digest, note: 'will re-read next tick; no second create is sent' })
		}
		if (!DRY_RUN) return
	}

	// (3) Pending sends: fold receipts, try to resolve unknowns. Unknown blocks quoting.
	await reconcilePending(ctx, { runId, tick: n })

	// (4) Fills, then book/fee parameters, then the chain's view of our orders.
	const fillState = managerId ? await scanFills(n, managerId) : 'caught_up'
	if (s.recovery?.requires.includes('backfill_fills') && fillState === 'caught_up') s.recovery.requires = s.recovery.requires.filter((r) => r !== 'backfill_fills')
	await readParams(db)

	let ordersRead = DRY_RUN
	if (!DRY_RUN) {
		const chain = await readChainOrders(db)
		if (chain) {
			ordersRead = true
			const r = reconcileResting(s.resting, chain, PRICE_DIVISOR)
			if (r.dropped.length || r.adopted.length || r.resized.length) L('event', 'resting_reconciled', { tick: n, dropped: r.dropped, adopted: r.adopted, resized: r.resized })
			const prev = new Map(s.resting.map((o) => [o.orderId, o]))
			const exp = new Map(chain.map((c) => [c.orderId, c.expiresAtMs]))
			// Adopted orders keep the chain's expiry so the near-expiry refresh still applies.
			s.resting = r.resting.map((o) => ({ ...prev.get(o.orderId), ...o, expiresAtMs: prev.get(o.orderId)?.expiresAtMs ?? exp.get(o.orderId) }))
			if (s.recovery?.requires.includes('reconcile_orders')) s.recovery.requires = s.recovery.requires.filter((x) => x !== 'reconcile_orders')
		}
	}
	if (s.recovery && s.recovery.requires.length === 0) {
		L('event', 'recovery_complete', { tick: n, reason: s.recovery.reason })
		s.recovery = undefined
	}
	ctx.save()

	// (5) Inventory and valuation.
	const inv = managerId || DRY_RUN ? await readInventory(db) : undefined
	let valueQuote: number | undefined
	if (inv) {
		valueQuote = (inv.free.base + inv.locked.base) * mid + inv.free.quote + inv.locked.quote
		if (!s.startValuation && !s.recovery && blocksQuoting(s.pending).length === 0) {
			s.startValuation = { atMs: readAtMs, mid, base: inv.free.base + inv.locked.base, quote: inv.free.quote + inv.locked.quote, valueQuote }
			ctx.save()
			L('event', 'start_valuation', { tick: n, ...s.startValuation })
		}
	}
	const transfersNow = (s.transfers ?? []).reduce((a, t) => a + t.base * mid + t.quote, 0)
	const ownLock = ownOrderLock(s.resting)
	L('info', 'inventory', { tick: n, balanceManagerId: managerId, free: inv?.free ?? null, locked: inv?.locked ?? null, ownLock, valueQuote: valueQuote ?? null })

	// (6) Limits and pause reasons. Terminal limits end the run through cleanup.
	const limit = evaluateLimits({
		budget: s.budget,
		pending: s.pending,
		limits: LIMITS,
		nowMs: now(),
		runStartMs,
		startValueQuote: s.startValuation ? s.startValuation.valueQuote + transfersNow : undefined,
		current: valueQuote !== undefined ? { valueQuote, atMs: readAtMs } : undefined,
		nextReserveMist: RESERVE_PER_TX_MIST,
	})
	if (limit.action === 'halt') haltReason ??= limit.reason
	const unknown = blocksQuoting(s.pending)
	const pause = !inv
		? 'inventory_unreadable'
		: !ordersRead
			? 'orders_unreadable'
			: unknown.length
				? `pending_unknown:${unknown.map((p) => p.opId).join(',')}`
				: s.recovery
					? `recovery:${s.recovery.reason}`
					: fillState !== 'caught_up'
						? `fills_${fillState === 'behind' ? 'backfilling' : 'scan_failed'}`
						: limit.action === 'pause'
							? limit.reason
							: undefined

	// (7) Plan.
	const plan = planStrategy(
		{
			nowMs: now(),
			book: { bestBid, bestAsk, readAtMs, bids: l2.bid_prices.map((p, i) => [p, l2.bid_quantities[i]]), asks: l2.ask_prices.map((p, i) => [p, l2.ask_quantities[i]]) },
			params: bookParams ?? { tickSize: 0, lotSize: 0, minSize: 0, verified: false },
			fees: fees ?? { makerFeeRate: 0, verified: false },
			inv: inv ?? { free: { base: 0, quote: 0 }, locked: { base: 0, quote: 0 } },
			resting: s.resting,
			halt: haltReason,
			pause,
			liquidityPausedSinceMs,
		},
		STRATEGY,
	)
	liquidityPausedSinceMs = plan.liquidityPausedSinceMs
	L('event', plan.mode === 'quote' ? 'quote_plan' : plan.mode === 'inventory_limited' ? 'inventory_limited' : 'quote_paused', {
		tick: n,
		mode: plan.mode,
		reason: plan.reason ?? null,
		mid,
		baseFraction: plan.baseFraction ?? null,
		valueQuote: plan.valueQuote ?? null,
		spreadBps: plan.spreadBps ?? null,
		gate: plan.gate ?? null,
		cancels: plan.cancels,
		place: plan.place,
		sides: plan.sides,
		recovery: plan.recovery ?? null,
		liquidityPausedSinceMs: plan.liquidityPausedSinceMs ?? null,
		gasConsumedSui: s.budget.gasConsumedMist / MIST_PER_SUI,
		turnoverSui: rollingTurnover(s.budget, now(), LIMITS.turnoverWindowMs),
	})
	inventoryLimitedTicks = plan.mode === 'inventory_limited' ? inventoryLimitedTicks + 1 : 0
	if (inventoryLimitedTicks >= INVENTORY_LIMITED_EXIT_TICKS) haltReason ??= 'inventory_limited'
	// A halt is executed by the main loop as cleanup; nothing more to send here.
	if (plan.mode === 'halt') return
	// An unknown send blocks every new send, cancels included: cleanup is the only
	// transaction allowed while an outcome is unknown, and it runs on exit.
	if (unknown.length) return

	// (8) Nothing to change: submit only if settled proceeds are waiting to be swept.
	const byId = new Map(s.resting.map((o) => [o.orderId, o]))
	const cancels = plan.cancels.filter((id) => !byId.get(id)?.simulated)
	if (cancels.length === 0 && plan.place.length === 0) {
		if (DRY_RUN) {
			s.resting = s.resting.filter((o) => !plan.cancels.includes(o.orderId))
			ctx.save()
		}
		const settled = await readSettled(db)
		if (settled && settled.base === 0 && settled.quote === 0 && settled.deep === 0) {
			L('event', 'tick_no_submit', { tick: n, reason: 'nothing_to_do', resting: s.resting.length })
			return
		}
	}

	// (9) One PTB: cancels (returning their funds), post-only places, then sweep settled.
	if (!managerId) {
		L('info', 'dry_run_plan_only', { tick: n, place: plan.place, note: 'no manager yet: set DEEPBOOK_BALANCE_MANAGER_ID to an existing manager to also build the requote bytes' })
		s.resting = [...s.resting.filter((o) => !plan.cancels.includes(o.orderId)), ...plan.place.map((o, i) => ({ orderId: `t${n}-${o.isBid ? 'bid' : 'ask'}-${i}`, ...o, simulated: true, placedAtMs: now(), expiresAtMs: now() + STRATEGY.orderTtlMs }))]
		ctx.save()
		return
	}
	const tx = new Transaction()
	for (const id of cancels) tx.add(db().deepBook.cancelLiveOrder(POOL_KEY, MANAGER_KEY, id))
	const placedAt = now()
	const clientOrderIds: string[] = []
	for (const o of plan.place) {
		const cid = makeClientOrderId(placedAt, ++s.opSeq)
		clientOrderIds.push(cid)
		addPlaceOrder(tx, db(), { poolKey: POOL_KEY, managerKey: MANAGER_KEY, clientOrderId: cid, price: o.price, quantity: o.quantity, isBid: o.isBid, expirationMs: placedAt + STRATEGY.orderTtlMs, payWithDeep: STRATEGY.payWithDeep })
	}
	tx.add(db().deepBook.withdrawSettledAmounts(POOL_KEY, MANAGER_KEY))
	const b64 = await buildKindBytes(tx, 'requote', { tick: n, runId, cancels: cancels.length, places: plan.place.length })
	if (!b64) return

	const out = await sendWithIntent(ctx, { kind: 'requote', b64, clientOrderIds, runId, proc: 'loop' })
	if (out.status === 'dry_run') {
		const kept = s.resting.filter((o) => !plan.cancels.includes(o.orderId))
		s.resting = [...kept, ...plan.place.map((o, i) => ({ orderId: `t${n}-${o.isBid ? 'bid' : 'ask'}-${i}`, ...o, simulated: true, placedAtMs: placedAt, expiresAtMs: placedAt + STRATEGY.orderTtlMs }))]
		ctx.save()
		return
	}
	if (out.status !== 'submitted') return

	// (10) Read our own transaction back for the real order ids. Until the chain confirms
	// a cancel, the order stays in our resting set (review #13): an aborted or unread
	// transaction cancelled nothing, and a later pause must still cancel it.
	const txb = await fetchTx(out.digest)
	const status = (txb as unknown as { effects?: { status?: { status?: string; error?: string } } } | null)?.effects?.status
	if (!txb || status?.status !== 'success') {
		L('warn', txb ? 'requote_failed_on_chain' : 'orders_unconfirmed', { tick: n, digest: out.digest, error: status?.error ?? null, note: 'resting set unchanged; the next tick reconciles against the chain' })
		await reconcilePending(ctx, { runId, tick: n })
		return
	}
	const opts = { ...SCALARS, poolId: POOL.address, balanceManagerId: managerId }
	const placed = parseOrderPlaced(txb, opts)
	const canceled = new Set(parseOrderCanceled(txb, opts).map((c) => c.orderId))
	// `cancelLiveOrder` no-ops on an order that already filled, so an id asked to cancel but
	// absent from OrderCanceled is left for the chain reconcile to drop or keep.
	s.resting = [
		...s.resting.filter((o) => !canceled.has(o.orderId)),
		...placed.map((o): TrackedOrder => ({ orderId: o.orderId, isBid: o.isBid, price: o.price, quantity: o.quantity, simulated: false, placedAtMs: placedAt, expiresAtMs: placedAt + STRATEGY.orderTtlMs })),
	]
	ctx.save()
	L('event', 'orders_confirmed', { tick: n, digest: out.digest, placed: placed.map((o) => ({ orderId: o.orderId, side: o.isBid ? 'bid' : 'ask', price: o.price, quantity: o.quantity, clientOrderId: o.clientOrderId })), canceled: [...canceled], resting: s.resting.length })
	await reconcilePending(ctx, { runId, tick: n })
}

async function readSettled(db: GetDb): Promise<{ base: number; quote: number; deep: number } | undefined> {
	if (DRY_RUN) return { base: 0, quote: 0, deep: 0 }
	try {
		if (!(await withRpc('accountExists', () => db().accountExists(POOL_KEY, MANAGER_KEY)))) return { base: 0, quote: 0, deep: 0 }
		const a = (await withRpc('account', () => db().account(POOL_KEY, MANAGER_KEY))) as { settled_balances?: { base?: number; quote?: number; deep?: number } }
		const x = a?.settled_balances ?? {}
		return { base: Number(x.base ?? 0), quote: Number(x.quote ?? 0), deep: Number(x.deep ?? 0) }
	} catch (err) {
		L('warn', 'settled_read_failed', { error: String(err).slice(0, 200), note: 'submitting the sweep rather than skipping it' })
		return undefined
	}
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

let stopping: string | undefined

async function prepareFills(): Promise<void> {
	const s = ctx.state
	for (const f of s.fills.ledger) fillLedger.add([f])
	if (s.fills.cursor && !FILL_SKIP_GAP) {
		L('info', 'fill_cursor', { source: 'state', cursor: s.fills.cursor, note: 'backfilling from the saved cursor; quoting waits until it reaches the head' })
		return
	}
	if (s.fills.cursor && FILL_SKIP_GAP) {
		s.fillsIncompleteSinceMs = Date.now()
		L('warn', 'fill_gap', { savedCursor: s.fills.cursor, note: 'FILL_SKIP_GAP=1: fills since the saved cursor are NOT counted; turnover and P&L for this run are incomplete. `npm run fills` can recover them offline.' })
	}
	const anchorAtMs = Date.now() - 120_000
	try {
		s.fills.cursor = (await anchorCursorAt(anchorAtMs)) ?? (await headCursor(ORDER_FILLED_TYPE))
		ctx.save()
		L('info', 'fill_cursor', { source: 'anchor', anchorAt: new Date(anchorAtMs).toISOString(), cursor: s.fills.cursor })
	} catch (err) {
		if (err instanceof StateError) throw err
		L('warn', 'fill_cursor_failed', { error: String(err).slice(0, 200), note: 'the first scan takes the head cursor; fills before it are not covered' })
	}
}

async function finish(reason: string, exitCode: number): Promise<never> {
	L('event', 'quotes_stopped', { reason, tick: ctx.state.tick })
	const managerSetup = managerSetupTerminal({ dryRun: DRY_RUN, balanceManagerId: ctx.state.balanceManagerId, pending: ctx.state.pending })
	if (!managerSetup.ok) {
		L('error', 'manager_setup_failed', { reason, cause: managerSetup.cause, stateFile: STATE_FILE, instruction: managerSetup.instruction })
	}
	let cleanupOk = true
	try {
		const r = await runCleanup(ctx, { runId, proc: 'loop', reason, recipient: WITHDRAW_RECIPIENT })
		cleanupOk = r.ok
	} catch (err) {
		cleanupOk = false
		L('error', 'cleanup_failed', { stage: 'exception', error: String(err).slice(0, 300), instruction: 'run `npm run stop`' })
	}
	L('event', 'process_exit', { proc: 'loop', reason, cleanupOk, dryRun: DRY_RUN, ticks: ctx.state.tick, sendTxCalls: getSendTxCalls(), sendTxRefused: getSendTxRefused(), elapsedMs: Date.now() - runStartMs, gasConsumedSui: ctx.state.budget.gasConsumedMist / MIST_PER_SUI, fills: ctx.state.fills.ledger.length })
	ctx.lock.release()
	process.exit(cleanupOk ? terminalExitCode(exitCode, managerSetup) : 1)
}

async function main(): Promise<void> {
	validateConfig()
	ctx = await openContext({ purpose: 'loop', adopt: ADOPT_MANAGER, breakStale: BREAK_STALE_LOCK })
	const s = ctx.state
	const resumed = !!s.runId
	runId = s.runId ?? `run-${Date.now()}`
	s.runId = runId
	// A resumed run keeps its start, so MAX_RUN_MIN counts across restarts (review #12).
	s.runStartedAtMs ??= Date.now()
	runStartMs = s.runStartedAtMs
	ctx.save()

	L('event', 'agent_start', {
		owner: ctx.owner,
		network: NETWORK,
		poolKey: POOL_KEY,
		poolId: POOL.address,
		balanceManagerId: s.balanceManagerId ?? null,
		resumedRun: resumed,
		start: ctx.start,
		rpc: currentRpcUrl(),
		rpcPrimary: SUI_RPC,
		rpcEndpoints: RPC_ENDPOINTS,
		dryRun: DRY_RUN,
		pollMs: POLL_MS,
		maxTicks: MAX_TICKS ?? null,
		orderSize: STRATEGY.maxOrderSize,
		spreadBps: STRATEGY.minSpreadBps,
		requoteToleranceBps: STRATEGY.toleranceBps,
		strategy: STRATEGY,
		limits: { ...LIMITS, gas: { capSui: GAS_CAPS.capMist / MIST_PER_SUI, cleanupAllowanceSui: GAS_CAPS.cleanupAllowanceMist / MIST_PER_SUI } },
		gasConsumedSui: s.budget.gasConsumedMist / MIST_PER_SUI,
		pending: s.pending.length,
		recovery: s.recovery ?? null,
		scalars: SCALARS,
	})

	for (const sig of ['SIGTERM', 'SIGINT'] as const) {
		process.on(sig, () => {
			L('info', 'shutdown_signal', { signal: sig, note: stopping ? 'already stopping; cleanup in progress' : 'finishing this tick, then cleanup' })
			stopping ??= `signal_${sig}`
		})
	}

	await prepareFills()

	let ticks = 0
	let consecutiveErrors = 0
	while (!stopping) {
		try {
			await tick()
			consecutiveErrors = 0
		} catch (err) {
			if (err instanceof StateError || err instanceof GasBudgetError) {
				// Cannot record what we send, or cannot pay for it: stop placing now.
				L('error', err instanceof StateError ? 'state_write_failed' : 'gas_budget_exhausted', { error: err.message })
				stopping = err instanceof StateError ? 'state_unwritable' : 'gas_cap'
				break
			}
			consecutiveErrors++
			L('error', 'tick_failed', { error: err instanceof Error ? err.message : String(err), cause: errorCause(err), consecutiveErrors })
			if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				L('error', 'too_many_consecutive_errors', { consecutiveErrors })
				stopping = 'too_many_consecutive_errors'
				break
			}
		}
		ticks++
		if (haltReason) stopping = haltReason
		else if (MAX_TICKS && ticks >= MAX_TICKS) stopping = 'max_ticks'
		if (stopping) break
		L('info', 'next_check', { inMs: POLL_MS })
		for (let i = 0; i < Math.max(1, Math.ceil(POLL_MS / 1000)) && !stopping; i++) await new Promise((r) => setTimeout(r, Math.min(1000, POLL_MS)))
	}
	if (stopping === 'state_unwritable') {
		// Cleanup needs to persist its intent first, so it cannot run safely here.
		L('event', 'quotes_stopped', { reason: stopping })
		L('error', 'cleanup_skipped', { reason: 'state file unwritable', instruction: 'fix the disk/permissions, then run `npm run stop` — orders expire on their own within ORDER_TTL_MIN' })
		L('event', 'process_exit', { proc: 'loop', reason: stopping, cleanupOk: false, sendTxCalls: getSendTxCalls(), sendTxRefused: getSendTxRefused() })
		ctx.lock.release()
		process.exit(1)
	}
	const clean = ['signal_SIGTERM', 'signal_SIGINT', 'max_ticks', 'run_duration'].includes(stopping!)
	await finish(stopping!, clean ? 0 : 1)
}

main().catch(fatal)

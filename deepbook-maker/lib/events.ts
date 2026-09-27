/**
 * Pure parsers over the Sui RPC's transaction JSON — no network, no SDK, no clock.
 *
 * After a live `signAndSendTx` returns a digest, the agent refetches that transaction
 * with `{ showEvents: true, showObjectChanges: true }` and hands the result here. This
 * file turns it into three things the loop needs and cannot get any other way:
 *
 *   • the id of the BalanceManager a `create_balance_manager` transaction created
 *   • the real u128 order ids DeepBook issued for the orders we just placed
 *   • the fills that happened, so a 24 h run can count them on both sides
 *
 * ---------------------------------------------------------------------------
 * Event type strings (read off mainnet, not off a docs page)
 * ---------------------------------------------------------------------------
 * DeepBook's event structs carry the ORIGINAL package id, not the upgraded one the
 * SDK calls `DEEPBOOK_PACKAGE_ID`. On mainnet today:
 *
 *   struct package id   0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809
 *   SDK DEEPBOOK_PACKAGE_ID 0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748
 *
 * Matching on the full string with the SDK constant therefore finds nothing. These
 * parsers match on the `::module::Struct` suffix instead, which survives the next
 * upgrade as well.
 *
 *   `::order_info::OrderPlaced`   digest EiWShmMjLDeiaveYodNP2ZLT3MCYQfUBZTMcYFQXjDcD
 *   `::order::OrderCanceled`      digest 2DEcMC3NrSbC6vkyjjGcxp6i2qc2bPXLLWDmt8Phq7Rf
 *   `::order_info::OrderFilled`   digest 6eQtWxBR4dpyyhewZxRss7XZe38S5ryUgJyKjERU8sdh
 *
 * Note the modules differ: OrderPlaced and OrderFilled live in `order_info`,
 * OrderCanceled lives in `order`.
 */

/** One event as the JSON-RPC returns it. Only the two fields we read are required. */
export interface RpcEvent {
	type: string
	parsedJson?: unknown
}

/** One object change as the JSON-RPC returns it. */
export interface RpcObjectChange {
	type?: string
	objectType?: string
	objectId?: string
}

/** The slice of `getTransactionBlock({ showEvents, showObjectChanges })` we read. */
export interface RpcTransactionBlock {
	digest?: string
	events?: RpcEvent[] | null
	objectChanges?: RpcObjectChange[] | null
}

/**
 * On-chain integers are scaled. Pass the pool's own scalars — the agent reads them
 * from the SDK constants, see SDK-NOTES §D.
 */
export interface PoolScalars {
	/** `FLOAT_SCALAR`, 1e9. */
	floatScalar: number
	/** Base coin scalar, e.g. DEEP = 1e6. */
	baseScalar: number
	/** Quote coin scalar, e.g. SUI = 1e9. */
	quoteScalar: number
}

export interface ParseOptions extends PoolScalars {
	/** Keep only events for this pool. Omit to keep every pool. */
	poolId?: string
	/** Keep only events for this BalanceManager. Omit to keep every manager. */
	balanceManagerId?: string
}

/** An order DeepBook actually put on the book, in human units. */
export interface PlacedOrder {
	/** The u128 order id, as a decimal string. This is what `cancelOrder` takes. */
	orderId: string
	isBid: boolean
	price: number
	quantity: number
	clientOrderId: string
	poolId: string
	balanceManagerId: string
	/** Always false — the chain issued this id. */
	simulated: false
}

/** An order DeepBook took off the book. */
export interface CanceledOrder {
	orderId: string
	isBid: boolean
	price: number
	/** Base quantity that was still resting when the cancel landed. */
	quantity: number
	poolId: string
	balanceManagerId: string
}

/** A fill, seen from the side that had the resting order. */
export interface Fill {
	/** The resting (maker) order's u128 id. */
	makerOrderId: string
	/**
	 * The side of the *maker* order — which is us. The event reports `taker_is_bid`,
	 * so the maker sold when the taker bought: `isBid = !taker_is_bid`.
	 */
	isBid: boolean
	price: number
	/** Base filled, human units. */
	quantity: number
	/** Quote moved, human units. */
	quoteQuantity: number
	poolId: string
	makerBalanceManagerId: string
	takerBalanceManagerId: string
	timestampMs: string
}

// -----------------------------------------------------------------------------
// Scaling — see SDK-NOTES §D
// -----------------------------------------------------------------------------

/**
 * DeepBook stores a price as `price × FLOAT_SCALAR × quoteScalar ÷ baseScalar`
 * (`node_modules/@mysten/deepbook-v3/dist/utils/conversion.mjs:13`, `convertPrice`).
 * This is the inverse.
 */
export function priceToHuman(onChain: string | number | bigint, s: PoolScalars): number {
	const divisor = (s.floatScalar * s.quoteScalar) / s.baseScalar
	return Number(onChain) / divisor
}

/**
 * Quantities are scaled by the coin's own scalar (`convertQuantity`, same file :6).
 * Base quantities use the base scalar, quote quantities the quote scalar.
 */
export function quantityToHuman(onChain: string | number | bigint, scalar: number): number {
	return Number(onChain) / scalar
}

// -----------------------------------------------------------------------------
// Event plumbing
// -----------------------------------------------------------------------------

/** True when `type` is exactly `<package>::<module>::<Struct>` for the given suffix. */
export function isEventType(type: string, suffix: string): boolean {
	return typeof type === 'string' && type.endsWith(suffix)
}

function eventsOf(tx: RpcTransactionBlock | null | undefined): RpcEvent[] {
	return Array.isArray(tx?.events) ? tx.events : []
}

function fieldsOf(e: RpcEvent): Record<string, unknown> {
	return e.parsedJson && typeof e.parsedJson === 'object' ? (e.parsedJson as Record<string, unknown>) : {}
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

/** Does this event belong to the pool and manager we care about? */
function matches(f: Record<string, unknown>, managerField: string, opts: ParseOptions): boolean {
	if (opts.poolId && str(f.pool_id) !== opts.poolId) return false
	if (opts.balanceManagerId && str(f[managerField]) !== opts.balanceManagerId) return false
	return true
}

// -----------------------------------------------------------------------------
// Parsers
// -----------------------------------------------------------------------------

/**
 * `<pkg>::order_info::OrderPlaced` →
 *   `{ balance_manager_id, client_order_id, expire_timestamp, is_bid, order_id,
 *      placed_quantity, pool_id, price, timestamp, trader }`
 *
 * Note it is `placed_quantity`, not `quantity`. Ignore the sibling
 * `::order_info::OrderInfo` event — DeepBook emits one alongside every OrderPlaced and
 * it carries the same order under different field names.
 */
export function parseOrderPlaced(tx: RpcTransactionBlock | null | undefined, opts: ParseOptions): PlacedOrder[] {
	const out: PlacedOrder[] = []
	for (const e of eventsOf(tx)) {
		if (!isEventType(e.type, '::order_info::OrderPlaced')) continue
		const f = fieldsOf(e)
		if (!matches(f, 'balance_manager_id', opts)) continue
		out.push({
			orderId: str(f.order_id),
			isBid: f.is_bid === true,
			price: priceToHuman(str(f.price), opts),
			quantity: quantityToHuman(str(f.placed_quantity), opts.baseScalar),
			clientOrderId: str(f.client_order_id),
			poolId: str(f.pool_id),
			balanceManagerId: str(f.balance_manager_id),
			simulated: false,
		})
	}
	return out
}

/**
 * `<pkg>::order::OrderCanceled` →
 *   `{ balance_manager_id, base_asset_quantity_canceled, client_order_id, is_bid,
 *      order_id, original_quantity, pool_id, price, timestamp, trader }`
 */
export function parseOrderCanceled(tx: RpcTransactionBlock | null | undefined, opts: ParseOptions): CanceledOrder[] {
	const out: CanceledOrder[] = []
	for (const e of eventsOf(tx)) {
		if (!isEventType(e.type, '::order::OrderCanceled')) continue
		const f = fieldsOf(e)
		if (!matches(f, 'balance_manager_id', opts)) continue
		out.push({
			orderId: str(f.order_id),
			isBid: f.is_bid === true,
			price: priceToHuman(str(f.price), opts),
			quantity: quantityToHuman(str(f.base_asset_quantity_canceled), opts.baseScalar),
			poolId: str(f.pool_id),
			balanceManagerId: str(f.balance_manager_id),
		})
	}
	return out
}

/**
 * `<pkg>::order_info::OrderFilled` →
 *   `{ base_quantity, maker_balance_manager_id, maker_client_order_id, maker_fee,
 *      maker_fee_is_deep, maker_order_id, pool_id, price, quote_quantity,
 *      taker_balance_manager_id, taker_client_order_id, taker_fee, taker_fee_is_deep,
 *      taker_is_bid, taker_order_id, timestamp }`
 *
 * `balanceManagerId` in the options filters on the MAKER manager, because that is the
 * role this agent plays.
 */
export function parseOrderFilled(tx: RpcTransactionBlock | null | undefined, opts: ParseOptions): Fill[] {
	const out: Fill[] = []
	for (const e of eventsOf(tx)) {
		if (!isEventType(e.type, '::order_info::OrderFilled')) continue
		const f = fieldsOf(e)
		if (!matches(f, 'maker_balance_manager_id', opts)) continue
		out.push({
			makerOrderId: str(f.maker_order_id),
			isBid: f.taker_is_bid !== true,
			price: priceToHuman(str(f.price), opts),
			quantity: quantityToHuman(str(f.base_quantity), opts.baseScalar),
			quoteQuantity: quantityToHuman(str(f.quote_quantity), opts.quoteScalar),
			poolId: str(f.pool_id),
			makerBalanceManagerId: str(f.maker_balance_manager_id),
			takerBalanceManagerId: str(f.taker_balance_manager_id),
			timestampMs: str(f.timestamp),
		})
	}
	return out
}

/**
 * The BalanceManager a `create_balance_manager` transaction created.
 *
 * Read from `objectChanges`, not from events: `createAndShareBalanceManager` emits a
 * `balance_manager::BalanceManagerEvent` only on some paths, and `queryEvents` on that
 * type returns `[]` on mainnet (SDK-NOTES §C2). The created object is unambiguous.
 *
 * Matched on the exact suffix `::balance_manager::BalanceManager` so the `TradeCap`
 * created in the same transaction (`::balance_manager::TradeCap`) is not mistaken for
 * it. Verified against digest 8xMfiqw7HR9drnvVc8dKkN3jgW43PLVCJWeksLRip6GC, which
 * creates both.
 */
export function findCreatedBalanceManagerId(tx: RpcTransactionBlock | null | undefined): string | undefined {
	const changes = Array.isArray(tx?.objectChanges) ? tx.objectChanges : []
	for (const c of changes) {
		if (c?.type !== 'created') continue
		if (!isEventType(str(c.objectType), '::balance_manager::BalanceManager')) continue
		if (c.objectId) return c.objectId
	}
	return undefined
}

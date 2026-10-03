/**
 * Realized spread — the accounting convention, decided before the numbers exist.
 *
 * ## The question this settles
 *
 * The spread-vs-gas measure compares "spread earned (sum over fills)" against gas. Sale proceeds are not
 * spread earned: selling 20 DEEP for 0.42 SUI is not profit, it is a position closing.
 * Spread is earned only when a unit bought at the bid is sold at the ask. So the
 * convention has to say, explicitly, four things — and each is a real decision, not a
 * detail:
 *
 * 1. **Matched quantity.** Buys and sells are matched FIFO, oldest buy against the next
 *    sell. Realized spread on a matched unit is `sellPrice − buyPrice`, in quote (SUI)
 *    per base (DEEP). Only matched quantity contributes.
 *
 * 2. **Opening inventory.** DEEP the manager already holds when the run starts was not
 *    bought inside the run, so it has no run-local purchase price. It enters the FIFO
 *    queue at `openingBasis`, a price the caller must state — and the caller must say
 *    where it came from. For a run that started from a 20 DEEP fill, that is 0.02087 SUI/DEEP, the price
 *    the 20 DEEP was actually bought at on 2026-09-15 (digest
 *    `7Tt99TuU5xuFGkAzRhjSAbFZHv2LPsGL1FyLNTmrB5NX`). Selling that inventory realizes
 *    spread against that basis and nothing else. Marking it at the run's opening mid
 *    instead would manufacture or destroy spread that no trade produced, so the basis
 *    is a required input with no default.
 *
 * 3. **Unmatched fills.** Whatever is left in the queue at the end — bought and not
 *    sold, or sold short against opening inventory that ran out — is an OPEN position,
 *    not spread. It is reported separately as `openBase` and `unrealizedSui` (marked at
 *    the closing mid) and never added to `realizedSui`. A run that only bought has
 *    earned zero spread however far the price moved.
 *
 * 4. **Fees.** DeepBook charges the maker per fill; the event carries `maker_fee` and
 *    `maker_fee_is_deep`. On the whitelisted DEEP/SUI pool `poolTradeParams` is 0/0/0
 *    and the measured fills carry `maker_fee: 0` — but the arithmetic must not assume
 *    that. A fee paid in SUI is subtracted from realized spread directly. A fee paid in
 *    DEEP is a base-coin cost and is reported in DEEP (`feeBase`), NOT silently
 *    converted — converting it would need a price and would bury an assumption inside a
 *    number the ratio depends on. `netSui` subtracts only the SUI fees; a nonzero
 *    `feeBase` must be stated beside the ratio.
 *
 * Nothing here touches the network or the clock.
 */
import type { FeeAsset, Fill } from './events.ts'

export interface SpreadInput {
	/** Fills in time order. Only `isBid`, `price`, `quantity` and the fees are read. */
	fills: Array<
		Pick<Fill, 'isBid' | 'price' | 'quantity'> & {
			/** Our fee on this fill and its asset (from `parseOrderFilled`). */
			fee?: number
			feeAsset?: FeeAsset
			/** `self` fills are a wash and are skipped (their fees still count). */
			role?: Fill['role']
			/** Legacy form: maker fee, DEEP or quote. */
			makerFee?: number
			makerFeeIsDeep?: boolean
		}
	>
	/** Base (DEEP) held when the run started. */
	openingBase: number
	/** The price that opening inventory was actually acquired at. Required — see (2). */
	openingBasis: number
	/** Mid at the end of the run, used only to mark the open position. */
	closingMid: number
}

export interface SpreadResult {
	/** Base quantity that was both bought and sold inside the convention. */
	matchedBase: number
	/** Spread realized on matched quantity, in SUI, before fees. */
	grossRealizedSui: number
	/** Maker fees charged in SUI. */
	feeSui: number
	/** Fees charged in the base asset. Reported, never converted. */
	feeBase: number
	/** Fees charged in DEEP. Reported, never converted. On DEEP/SUI, DEEP is also the base asset. */
	feeDeep: number
	/** Fills where we were on both sides; excluded from matching. */
	selfFills: number
	/** Fills where we were the taker; included, and must be disclosed. */
	takerFills: number
	/** `grossRealizedSui − feeSui`. The figure the spread-vs-gas ratio uses. */
	realizedSui: number
	/** Base left open at the end. Positive = long, negative = short. */
	openBase: number
	/** The open position marked at `closingMid` against its basis. Never in `realizedSui`. */
	unrealizedSui: number
	/** How many fills were on each side. */
	buyFills: number
	sellFills: number
}

interface Lot {
	quantity: number
	price: number
}

/**
 * FIFO-match the fills and return the four figures separately.
 *
 * A sell with no lot left to match against is a short: it is pushed onto a short queue
 * and matched by the next buy, symmetrically. Neither side is silently discarded.
 */
export function realizedSpread(input: SpreadInput): SpreadResult {
	const { fills, openingBase, openingBasis, closingMid } = input

	/** Base bought and not yet sold, oldest first. Seeded with opening inventory. */
	const longs: Lot[] = openingBase > 0 ? [{ quantity: openingBase, price: openingBasis }] : []
	/** Base sold and not yet bought back, oldest first. */
	const shorts: Lot[] = []

	let matchedBase = 0
	let grossRealizedSui = 0
	let feeSui = 0
	let feeBase = 0
	let feeDeep = 0
	let selfFills = 0
	let takerFills = 0
	let buyFills = 0
	let sellFills = 0

	for (const f of fills) {
		if (f.fee) {
			if (f.feeAsset === 'DEEP') feeDeep += f.fee
			else if (f.feeAsset === 'base') feeBase += f.fee
			else feeSui += f.fee
		} else if (f.makerFee) {
			if (f.makerFeeIsDeep) feeDeep += f.makerFee
			else feeSui += f.makerFee
		}
		if (f.role === 'self') {
			selfFills++
			continue
		}
		if (f.role === 'taker') takerFills++

		let remaining = f.quantity
		if (f.isBid) {
			// A maker bid filled: we bought. Close any short first, then rest is a long lot.
			buyFills++
			while (remaining > 0 && shorts.length > 0) {
				const lot = shorts[0]
				const q = Math.min(remaining, lot.quantity)
				// Sold at lot.price, bought back at f.price.
				grossRealizedSui += (lot.price - f.price) * q
				matchedBase += q
				lot.quantity -= q
				remaining -= q
				if (lot.quantity <= 1e-12) shorts.shift()
			}
			if (remaining > 1e-12) longs.push({ quantity: remaining, price: f.price })
		} else {
			// A maker ask filled: we sold. Close the oldest long first.
			sellFills++
			while (remaining > 0 && longs.length > 0) {
				const lot = longs[0]
				const q = Math.min(remaining, lot.quantity)
				grossRealizedSui += (f.price - lot.price) * q
				matchedBase += q
				lot.quantity -= q
				remaining -= q
				if (lot.quantity <= 1e-12) longs.shift()
			}
			if (remaining > 1e-12) shorts.push({ quantity: remaining, price: f.price })
		}
	}

	const longBase = longs.reduce((a, l) => a + l.quantity, 0)
	const shortBase = shorts.reduce((a, l) => a + l.quantity, 0)
	const openBase = longBase - shortBase
	const unrealizedSui =
		longs.reduce((a, l) => a + (closingMid - l.price) * l.quantity, 0) +
		shorts.reduce((a, l) => a + (l.price - closingMid) * l.quantity, 0)

	return {
		matchedBase,
		grossRealizedSui,
		feeSui,
		feeBase,
		feeDeep,
		selfFills,
		takerFills,
		realizedSui: grossRealizedSui - feeSui,
		openBase,
		unrealizedSui,
		buyFills,
		sellFills,
	}
}

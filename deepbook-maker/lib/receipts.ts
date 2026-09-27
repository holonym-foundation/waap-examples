/**
 * Gas accounting — what a submitted transaction actually cost, from its receipt.
 *
 * ## Why this file exists
 *
 * `tx_submitted` logged `{tick, kind, digest}` and nothing else, and the only refetch
 * in the loop asked for `{ showEvents, showObjectChanges }` — not effects. So there was
 * no `gasUsed` anywhere in a run log, and the spread-vs-gas "sum of `gasUsed` over `tx_submitted`"
 * had nothing to sum. This file is the missing half.
 *
 * Gas is in the receipt's `effects.gasUsed`, four mist figures:
 *
 *   computationCost         paid for execution
 *   storageCost             paid to write the objects this transaction touched
 *   storageRebate           returned for storage this transaction freed
 *   nonRefundableStorageFee the slice of the rebate the protocol keeps
 *
 * **Net** is what leaves the wallet for good: `computation + storage − rebate`. That is
 * the figure a spread-versus-gas ratio compares
 * against. **Gross** is `computation + storage` — what the gas coin must cover at
 * submission time, before any rebate comes back. A budget needs both: net says what the
 * run costs, gross says what the wallet must hold to be allowed to submit at all.
 *
 * The rebate is already net of `nonRefundableStorageFee` in the RPC's own figure — it
 * is reported separately and must NOT be subtracted again.
 *
 * Verified against real mainnet receipts for this recipe's own submitted digests; see
 * the measured per-shape costs.
 */

export const MIST_PER_SUI = 1e9

/** `effects.gasUsed` as the JSON-RPC returns it — mist, as decimal strings. */
export interface RpcGasUsed {
	computationCost?: string | number
	storageCost?: string | number
	storageRebate?: string | number
	nonRefundableStorageFee?: string | number
}

/** The slice of `getTransactionBlock({ showEffects: true })` this module reads. */
export interface RpcEffects {
	status?: { status?: string; error?: string }
	gasUsed?: RpcGasUsed
}

export interface RpcReceipt {
	digest?: string
	timestampMs?: string
	effects?: RpcEffects | null
}

/** One transaction's cost, in both the figures a budget needs. */
export interface GasReceipt {
	digest: string
	status: string
	error?: string
	timestampMs?: string
	computationMist: number
	storageMist: number
	rebateMist: number
	nonRefundableMist: number
	/** computation + storage − rebate, in SUI. What the run actually costs. */
	netSui: number
	/** computation + storage, in SUI. What the gas coin must cover at submission. */
	grossSui: number
}

function mist(v: string | number | undefined): number {
	if (v === undefined || v === null) return 0
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}

/**
 * Parse one receipt. Returns null only when there are no effects at all — a FAILED
 * transaction still burned gas and is still returned, with its status and error, because
 * a budget that ignores failed submissions understates the burn.
 */
export function parseGasUsed(receipt: RpcReceipt | null | undefined, digest?: string): GasReceipt | null {
	const effects = receipt?.effects
	if (!effects?.gasUsed) return null
	const g = effects.gasUsed
	const computationMist = mist(g.computationCost)
	const storageMist = mist(g.storageCost)
	const rebateMist = mist(g.storageRebate)
	const nonRefundableMist = mist(g.nonRefundableStorageFee)
	return {
		digest: receipt?.digest ?? digest ?? '',
		status: effects.status?.status ?? 'unknown',
		error: effects.status?.error,
		timestampMs: receipt?.timestampMs,
		computationMist,
		storageMist,
		rebateMist,
		nonRefundableMist,
		netSui: (computationMist + storageMist - rebateMist) / MIST_PER_SUI,
		grossSui: (computationMist + storageMist) / MIST_PER_SUI,
	}
}

export interface GasTotals {
	count: number
	netSui: number
	grossSui: number
	/** Mean net cost per transaction — the per-tick figure a budget multiplies. */
	meanNetSui: number
	minNetSui: number
	maxNetSui: number
	failed: number
}

/** Sum a set of receipts. `min`/`max` are the spread a single-sample estimate hides. */
export function totalGas(receipts: GasReceipt[]): GasTotals {
	const nets = receipts.map((r) => r.netSui)
	const netSui = nets.reduce((a, b) => a + b, 0)
	const grossSui = receipts.reduce((a, r) => a + r.grossSui, 0)
	return {
		count: receipts.length,
		netSui,
		grossSui,
		meanNetSui: receipts.length ? netSui / receipts.length : 0,
		minNetSui: nets.length ? Math.min(...nets) : 0,
		maxNetSui: nets.length ? Math.max(...nets) : 0,
		failed: receipts.filter((r) => r.status !== 'success').length,
	}
}

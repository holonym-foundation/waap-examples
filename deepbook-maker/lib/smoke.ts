/**
 * The smoke-run grade — pure, no network, no clock.
 *
 * `grade-smoke.ts` gathers the inputs (the run log, every receipt, the chain after the
 * stop) and hands them here. Everything that decides the verdict is in this file, so
 * the fixtures in `smoke.test.ts` exercise the real rules.
 *
 * ## Verdicts
 *
 * - `PASS`: every condition holds and every submitted transaction succeeded.
 * - `PASS_WITH_DISCLOSED_EXCEPTION`: every condition holds, and one or more requotes
 *   failed on chain with `InsufficientGas` on a gas budget the WaaP preparation step
 *   set, each followed by a successful requote in the same run. Every such failure is
 *   listed with its fee and its recovery, and must be disclosed wherever the run is
 *   cited. It is never reported as "every transaction succeeded".
 * - `FAIL`: anything else, including missing evidence.
 *
 * ## Why the exception exists, and why it is this narrow
 *
 * waap-cli (Standard mode, Sui) reduces every transaction to kind bytes and passes no
 * gas budget; the backend's preparation step estimates one with a thin margin. When the
 * book moves between preparation and execution, the real cost can pass that budget and
 * the transaction aborts with `InsufficientGas`. The agent cannot set the budget. The
 * exception covers exactly that, and nothing else: any other error, a failure without
 * a later success, a failed deposit or stop, a missing receipt, or code that sets its
 * own budget all FAIL.
 */

export type SmokeVerdict = 'PASS' | 'PASS_WITH_DISCLOSED_EXCEPTION' | 'FAIL'

export interface LogLine {
	ts: string
	message: string
	[k: string]: unknown
}

export interface SmokeReceipt {
	digest: string
	/** `success` or `failure`; anything else is treated as missing evidence. */
	status: string
	error?: string
	/** The transaction's gas budget in MIST, from `transaction.data.gasData.budget`. */
	budgetMist?: number
	netSui: number
}

export interface AfterStop {
	/** The stop transaction's digest, from the log's `stop_done` line. */
	stopDigest?: string
	/** `accountOpenOrders` after the stop. Undefined means the read failed. */
	openOrders?: string[]
	/** Manager balances after the stop. Undefined means the read failed. */
	managerBase?: number
	managerQuote?: number
	/** Whether the agent's pid file still exists (it is removed on a clean exit). */
	pidFilePresent: boolean
}

export interface SmokeInput {
	lines: LogLine[]
	/** Keyed by digest. A digest with no entry is a missing receipt. */
	receipts: Record<string, SmokeReceipt>
	afterStop: AfterStop
	/** True when the shipped code sets a gas budget anywhere (static check). */
	codeSetsGasBudget: boolean
	/** The minimum run length, from `agent_start` to `shutdown`. */
	minMinutes?: number
}

export interface SmokeException {
	digest: string
	tick?: number
	error: string
	budgetMist?: number
	netSui: number
	/** The first later successful requote in the same run. */
	recoveredBy: string
	recoveredAtTick?: number
}

export interface SmokeGrade {
	verdict: SmokeVerdict
	failures: string[]
	exceptions: SmokeException[]
	facts: Record<string, unknown>
}

const SETTINGS = ['pollMs', 'orderSize', 'spreadBps', 'requoteToleranceBps', 'maxTicks', 'dryRun'] as const

function isU128(id: unknown): boolean {
	return typeof id === 'string' && /^\d+$/.test(id) && id.length >= 10
}

export function gradeSmoke(input: SmokeInput): SmokeGrade {
	const failures: string[] = []
	const exceptions: SmokeException[] = []
	const minMinutes = input.minMinutes ?? 60
	const { lines, receipts } = input

	// --- 1. one start, a shutdown, long enough, no failed tick ------------------------
	const starts = lines.filter((l) => l.message === 'agent_start')
	if (starts.length !== 1) failures.push(`expected exactly 1 agent_start, found ${starts.length}`)
	const start = starts[0]
	const shutdown = lines.find((l) => l.message === 'shutdown')
	if (!shutdown) failures.push('no shutdown line')
	let minutes: number | undefined
	if (start && shutdown) {
		minutes = (Date.parse(shutdown.ts) - Date.parse(start.ts)) / 60_000
		if (!(minutes >= minMinutes)) failures.push(`ran ${minutes.toFixed(1)} min from agent_start to shutdown; needs ≥ ${minMinutes}`)
	}
	const tickFailed = lines.filter((l) => l.message === 'tick_failed').length
	if (tickFailed !== 0) failures.push(`tick_failed = ${tickFailed}`)
	if (lines.some((l) => l.message === 'too_many_consecutive_errors')) failures.push('the loop exited on too_many_consecutive_errors')
	if (start && start['dryRun'] !== false) failures.push('agent_start is not a live run (dryRun is not false)')

	// Settings recorded with the evidence.
	const missingSettings = start ? SETTINGS.filter((k) => start[k] === undefined) : [...SETTINGS]
	if (missingSettings.length) failures.push(`agent_start is missing settings: ${missingSettings.join(', ')}`)

	// --- 2. every submission has a receipt; failures are exceptions or FAIL -------------
	const submitted = lines.filter((l) => l.message === 'tx_submitted' && typeof l['digest'] === 'string')
	const loopSubmitted = start && shutdown
		? submitted.filter((l) => l.ts >= start.ts && l.ts <= shutdown.ts && l['tick'] !== undefined)
		: submitted.filter((l) => l['tick'] !== undefined)

	const successfulRequotes = submitted
		.filter((l) => l['kind'] === 'requote' && receipts[String(l['digest'])]?.status === 'success')
		.map((l) => ({ digest: String(l['digest']), tick: l['tick'] as number | undefined, ts: l.ts }))

	for (const l of submitted) {
		const digest = String(l['digest'])
		const kind = String(l['kind'] ?? '')
		const r = receipts[digest]
		if (!r) {
			failures.push(`missing receipt for ${kind} ${digest}`)
			continue
		}
		if (r.status === 'success') continue
		if (r.status !== 'failure') {
			failures.push(`receipt for ${kind} ${digest} has status "${r.status}"`)
			continue
		}
		const error = r.error ?? ''
		const why = (reason: string) => failures.push(`${kind} ${digest} failed on chain (${error || 'no error text'}), not exempt: ${reason}`)
		if (kind !== 'requote') { why('only requotes can be exempt; deposit, create and stop must succeed'); continue }
		if (!/InsufficientGas/.test(error)) { why('the error is not InsufficientGas'); continue }
		if (input.codeSetsGasBudget) { why('the shipped code sets its own gas budget, so the budget is not WaaP-set'); continue }
		const recovery = successfulRequotes.find((s) => s.ts > l.ts)
		if (!recovery) { why('no successful requote followed it in the same run'); continue }
		exceptions.push({
			digest,
			tick: l['tick'] as number | undefined,
			error,
			budgetMist: r.budgetMist,
			netSui: r.netSui,
			recoveredBy: recovery.digest,
			recoveredAtTick: recovery.tick,
		})
	}

	// --- 3. at least one real placement in a successful transaction -------------------
	const realPlacement = lines.some(
		(l) =>
			l.message === 'orders_confirmed' &&
			receipts[String(l['digest'])]?.status === 'success' &&
			Array.isArray(l['placed']) &&
			(l['placed'] as Array<{ orderId?: unknown }>).some((p) => isU128(p.orderId)),
	)
	if (!realPlacement) failures.push('no successful requote placed a real order (no orders_confirmed with a u128 id)')

	// --- 4. counters reconcile for the loop process -------------------------------------
	if (shutdown) {
		const calls = Number(shutdown['sendTxCalls'])
		const refused = Number(shutdown['sendTxRefused'] ?? 0)
		if (!Number.isFinite(calls)) failures.push('shutdown has no sendTxCalls')
		else if (calls - refused !== loopSubmitted.length)
			failures.push(`sendTxCalls ${calls} − sendTxRefused ${refused} ≠ ${loopSubmitted.length} tx_submitted in the loop`)
	}

	// --- 5. cleanup, verified on chain ------------------------------------------------------
	const a = input.afterStop
	if (a.pidFilePresent) failures.push('the agent pid file still exists after the stop (process may have survived)')
	if (!a.stopDigest) failures.push('no stop transaction in the log')
	else {
		const r = receipts[a.stopDigest]
		if (!r) failures.push(`missing receipt for stop ${a.stopDigest}`)
		else if (r.status !== 'success') failures.push(`stop ${a.stopDigest} did not succeed (${r.error ?? r.status})`)
	}
	if (a.openOrders === undefined) failures.push('open orders after the stop could not be read')
	else if (a.openOrders.length) failures.push(`${a.openOrders.length} orders still open after the stop`)
	if (a.managerBase === undefined || a.managerQuote === undefined) failures.push('manager balances after the stop could not be read')
	else if (a.managerBase !== 0 || a.managerQuote !== 0) failures.push(`manager not empty after the stop: base ${a.managerBase}, quote ${a.managerQuote}`)

	const verdict: SmokeVerdict = failures.length ? 'FAIL' : exceptions.length ? 'PASS_WITH_DISCLOSED_EXCEPTION' : 'PASS'
	return {
		verdict,
		failures,
		exceptions,
		facts: {
			minutes: minutes === undefined ? null : Number(minutes.toFixed(2)),
			ticks: shutdown?.['ticks'] ?? null,
			submitted: submitted.length,
			loopSubmitted: loopSubmitted.length,
			successfulRequotes: successfulRequotes.length,
			exceptionNetSui: Number(exceptions.reduce((s, e) => s + e.netSui, 0).toFixed(9)),
			settings: start ? Object.fromEntries(SETTINGS.map((k) => [k, start[k] ?? null])) : null,
		},
	}
}

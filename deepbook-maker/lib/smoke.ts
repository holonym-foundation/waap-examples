/**
 * The smoke-run grade — pure, no network, no clock.
 *
 * `grade-smoke.ts` gathers the inputs (the run log, every receipt, an independent read of
 * the chain at grading time) and hands them here. Everything that decides the verdict is
 * in this file, so `smoke.test.ts` exercises the real rules.
 *
 * ## The lifecycle it grades
 *
 * One run, identified by `runId`, carried on every line the loop and the stop write:
 *
 *   agent_start → ticks → quotes_stopped → cleanup_started → cleanup_confirmed → process_exit
 *
 * `quotes_stopped` is the moment the loop stops placing. After it, nothing may place.
 * `cleanup_confirmed` is cancel → settle → withdraw landed AND a timestamped read of the
 * chain found no open order, no settled balance and an empty manager. The loop runs
 * cleanup itself on every handled exit; `stop.ts` runs the same cleanup for a run that
 * could not (a crash) and writes the same lines under the same `runId`.
 *
 * ## Verdicts
 *
 * - `PASS`: every condition holds, every transaction succeeded, cleanup was prompt.
 * - `PASS_WITH_DISCLOSED_EXCEPTION`: every condition holds, and there is something that
 *   must be disclosed wherever the run is cited. Two kinds, reported separately:
 *   - `gasExceptions` — a requote failed on chain with `InsufficientGas` on a budget the
 *     WaaP preparation step set, followed by a successful requote in the same run, before
 *     quoting stopped.
 *   - `lateCleanup` — cleanup was confirmed more than `lateCleanupMinutes` after quoting
 *     stopped. The run is still clean at the end; the delay is a fact about operations.
 *   - `readFailures` — ticks that failed while nothing was being sent (an RPC read outage),
 *     at most `maxReadFailures` (default 5) per run. A failed tick next to a send FAILS.
 * - `FAIL`: anything else, including missing evidence.
 *
 * ## Utility is graded separately
 *
 * A clean lifecycle that never filled proves the plumbing, not the maker. `utility` is
 * `DEMONSTRATED` only with at least one real placement and at least one fill in the run;
 * otherwise `INCONCLUSIVE`. It never changes the verdict and never passes on its own.
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

export interface Residuals {
	openOrders?: string[]
	settled?: { base: number; quote: number; deep: number }
	managerBase?: number
	managerQuote?: number
	managerDeep?: number
}

/** What the grader itself reads from chain at grading time — independent of the log. */
export interface FinalCheck extends Residuals {
	atMs?: number
	/** Whether the account/network/pool lock is still on disk. */
	lockPresent: boolean
}

export interface SmokeInput {
	lines: LogLine[]
	/** The run to grade. Defaults to the last `agent_start`'s `runId`. */
	runId?: string
	/** Keyed by digest. A digest with no entry is a missing receipt. */
	receipts: Record<string, SmokeReceipt>
	finalCheck: FinalCheck
	/** True when the shipped code sets a gas budget anywhere (static check). */
	codeSetsGasBudget: boolean
	/** Minimum quoting time, from `agent_start` to `quotes_stopped`. Default 60. */
	minMinutes?: number
	/** Cleanup confirmed later than this after `quotes_stopped` is disclosed. Default 15. */
	lateCleanupMinutes?: number
	/** Failed ticks that sent nothing (read-only outages), disclosed up to this many. Default 5. */
	maxReadFailures?: number
}

export interface SmokeException {
	digest: string
	tick?: number
	error: string
	budgetMist?: number
	netSui: number
	/** The first later successful requote in the same run, before quoting stopped. */
	recoveredBy: string
	recoveredAtTick?: number
}

export interface SmokeGrade {
	verdict: SmokeVerdict
	failures: string[]
	exceptions: SmokeException[]
	disclosures: { gasExceptions: number; lateCleanup: { minutes: number } | null; readFailures: string[] }
	utility: 'DEMONSTRATED' | 'INCONCLUSIVE'
	facts: Record<string, unknown>
}

const SETTINGS = ['pollMs', 'orderSize', 'spreadBps', 'requoteToleranceBps', 'maxTicks', 'dryRun'] as const
const IDENTITY = ['owner', 'network', 'poolKey', 'poolId', 'balanceManagerId'] as const

function isU128(id: unknown): boolean {
	return typeof id === 'string' && /^\d+$/.test(id) && id.length >= 10
}

const t = (l: LogLine | undefined) => (l ? Date.parse(l.ts) : NaN)

export function residualFailures(label: string, r: Residuals): string[] {
	const out: string[] = []
	if (r.openOrders === undefined) out.push(`${label}: open orders could not be read`)
	else if (r.openOrders.length) out.push(`${label}: ${r.openOrders.length} orders still open`)
	if (r.settled === undefined) out.push(`${label}: settled balances could not be read`)
	else if (r.settled.base !== 0 || r.settled.quote !== 0 || r.settled.deep !== 0)
		out.push(`${label}: settled balances not swept (base ${r.settled.base}, quote ${r.settled.quote}, deep ${r.settled.deep})`)
	if (r.managerBase === undefined || r.managerQuote === undefined) out.push(`${label}: manager balances could not be read`)
	else if (r.managerBase !== 0 || r.managerQuote !== 0 || (r.managerDeep ?? 0) !== 0)
		out.push(`${label}: manager not empty (base ${r.managerBase}, quote ${r.managerQuote}, deep ${r.managerDeep ?? 0})`)
	return out
}

export function gradeSmoke(input: SmokeInput): SmokeGrade {
	const failures: string[] = []
	const exceptions: SmokeException[] = []
	const minMinutes = input.minMinutes ?? 60
	const lateMinutes = input.lateCleanupMinutes ?? 15
	const { receipts } = input

	// --- 0. which run, and is it one uninterrupted run ------------------------------------
	const allStarts = input.lines.filter((l) => l.message === 'agent_start')
	const runId = input.runId ?? (allStarts.at(-1)?.['runId'] as string | undefined)
	const lines = runId ? input.lines.filter((l) => l['runId'] === runId) : []
	if (!runId) failures.push('no agent_start with a runId in the log')

	const starts = lines.filter((l) => l.message === 'agent_start')
	if (runId && starts.length !== 1) failures.push(`expected exactly 1 agent_start for run ${runId}, found ${starts.length} (a restart is not one uninterrupted run)`)
	const start = starts[0]

	// --- 1. one identity across the run ---------------------------------------------------
	if (start) {
		for (const l of lines) {
			for (const k of IDENTITY) {
				if (l[k] !== undefined && start[k] !== undefined && l[k] !== start[k]) {
					failures.push(`${l.message} at ${l.ts} has ${k} ${String(l[k])}; the run's is ${String(start[k])}`)
				}
			}
		}
		for (const k of IDENTITY) if (start[k] === undefined || start[k] === null) failures.push(`agent_start is missing ${k}`)
	}

	// --- 2. lifecycle markers and chronology ---------------------------------------------
	const quotesStopped = lines.find((l) => l.message === 'quotes_stopped')
	if (!quotesStopped) failures.push('no quotes_stopped line: the run never recorded when it stopped placing')
	const confirmed = lines.filter((l) => l.message === 'cleanup_confirmed')
	const cleanup = confirmed.at(-1)
	if (!cleanup) failures.push('no cleanup_confirmed for this run')

	let minutes: number | undefined
	if (start && quotesStopped) {
		minutes = (t(quotesStopped) - t(start)) / 60_000
		if (!(minutes >= minMinutes)) failures.push(`quoted ${minutes.toFixed(1)} min from agent_start to quotes_stopped; needs ≥ ${minMinutes}`)
	}
	// A failed tick is exempt only when nothing was being sent: no send intent, submission
	// or unknown outcome since the previous tick ended. Those are disclosed, at most
	// `maxReadFailures` per run. Anything else FAILS.
	const readFailures: string[] = []
	let sinceTick: LogLine[] = []
	for (const l of lines) {
		if (l.message === 'next_check' || l.message === 'agent_start') {
			sinceTick = []
			continue
		}
		if (l.message === 'tick_failed') {
			const sending = sinceTick.some((x) => ['op_intent', 'tx_submitted', 'send_outcome_unknown', 'send_refused'].includes(x.message))
			if (sending) failures.push(`tick_failed at ${l.ts} while a send was in progress: ${String(l['error'] ?? '')}`)
			else readFailures.push(l.ts)
			continue
		}
		sinceTick.push(l)
	}
	const maxReadFailures = input.maxReadFailures ?? 5
	if (readFailures.length > maxReadFailures) failures.push(`${readFailures.length} read-only tick failures; at most ${maxReadFailures} are disclosable`)
	if (lines.some((l) => l.message === 'too_many_consecutive_errors')) failures.push('the loop exited on too_many_consecutive_errors')
	if (start && start['dryRun'] !== false) failures.push('agent_start is not a live run (dryRun is not false)')
	const missingSettings = start ? SETTINGS.filter((k) => start[k] === undefined) : [...SETTINGS]
	if (missingSettings.length) failures.push(`agent_start is missing settings: ${missingSettings.join(', ')}`)

	const inQuoting = (l: LogLine) => !!start && !!quotesStopped && t(l) >= t(start) && t(l) <= t(quotesStopped)

	// --- 3. every submission has a receipt; failures are exceptions or FAIL -------------
	const submitted = lines.filter((l) => l.message === 'tx_submitted' && typeof l['digest'] === 'string')
	const successfulRequotes = submitted
		.filter((l) => l['kind'] === 'requote' && receipts[String(l['digest'])]?.status === 'success' && inQuoting(l))
		.map((l) => ({ digest: String(l['digest']), tick: l['tick'] as number | undefined, ts: t(l) }))

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
		if (kind !== 'requote') { why('only requotes can be exempt; deposit, create and cleanup must succeed'); continue }
		if (!/InsufficientGas/.test(error)) { why('the error is not InsufficientGas'); continue }
		if (input.codeSetsGasBudget) { why('the shipped code sets its own gas budget, so the budget is not WaaP-set'); continue }
		if (!inQuoting(l)) { why('it is outside the run’s quoting window'); continue }
		const recovery = successfulRequotes.find((s) => s.ts > t(l))
		if (!recovery) { why('no successful requote followed it in the same run before quoting stopped'); continue }
		exceptions.push({ digest, tick: l['tick'] as number | undefined, error, budgetMist: r.budgetMist, netSui: r.netSui, recoveredBy: recovery.digest, recoveredAtTick: recovery.tick })
	}

	// --- 4. real placement inside the window, none after quiescence -----------------------
	const placements = lines.filter(
		(l) => l.message === 'orders_confirmed' && Array.isArray(l['placed']) && (l['placed'] as Array<{ orderId?: unknown }>).some((p) => isU128(p.orderId)),
	)
	const realPlacement = placements.some((l) => receipts[String(l['digest'])]?.status === 'success' && inQuoting(l))
	if (!realPlacement) failures.push('no successful requote placed a real order inside the quoting window')
	if (quotesStopped) {
		const late = submitted.filter((l) => l['kind'] === 'requote' && t(l) > t(quotesStopped))
		if (late.length) failures.push(`${late.length} requote(s) submitted after quotes_stopped: ${late.map((l) => l['digest']).join(', ')}`)
		const latePlaced = placements.filter((l) => t(l) > t(quotesStopped))
		if (latePlaced.length) failures.push(`${latePlaced.length} placement(s) confirmed after quotes_stopped`)
	}

	// --- 5. counters reconcile for the loop process ---------------------------------------
	const exit = lines.find((l) => l.message === 'process_exit' && l['proc'] === 'loop')
	if (!exit) failures.push('no process_exit from the loop')
	else {
		const calls = Number(exit['sendTxCalls'])
		const refused = Number(exit['sendTxRefused'] ?? 0)
		const loopSubmitted = submitted.filter((l) => l['proc'] === 'loop').length
		if (!Number.isFinite(calls)) failures.push('process_exit has no sendTxCalls')
		else if (calls - refused !== loopSubmitted) failures.push(`sendTxCalls ${calls} − sendTxRefused ${refused} ≠ ${loopSubmitted} tx_submitted by the loop`)
	}

	// --- 6. cleanup: after everything, landed, and verified twice --------------------------
	let lateCleanup: { minutes: number } | null = null
	if (cleanup) {
		const lastAction = submitted.filter((l) => l['kind'] !== 'cleanup').at(-1)
		if (quotesStopped && t(cleanup) < t(quotesStopped)) failures.push(`cleanup_confirmed at ${cleanup.ts} is before quotes_stopped at ${quotesStopped.ts}`)
		if (start && t(cleanup) < t(start)) failures.push(`cleanup_confirmed at ${cleanup.ts} is before the run started`)
		if (lastAction && t(cleanup) < t(lastAction)) failures.push(`cleanup_confirmed at ${cleanup.ts} is before the last ${String(lastAction['kind'])} at ${lastAction.ts}`)
		const digest = cleanup['digest'] as string | undefined
		if (!digest) failures.push('cleanup_confirmed carries no digest')
		else {
			const r = receipts[digest]
			if (!r) failures.push(`missing receipt for cleanup ${digest}`)
			else if (r.status !== 'success') failures.push(`cleanup ${digest} did not succeed (${r.error ?? r.status})`)
			const sub = submitted.find((l) => l['digest'] === digest)
			const readAt = Date.parse(String(cleanup['residualsReadAt'] ?? ''))
			if (!Number.isFinite(readAt)) failures.push('cleanup_confirmed has no residualsReadAt timestamp')
			else if (sub && readAt < t(sub)) failures.push('cleanup residuals were read before the cleanup transaction was submitted')
		}
		failures.push(...residualFailures('cleanup_confirmed residuals', (cleanup['residuals'] ?? {}) as Residuals))
		if (quotesStopped) {
			const m = (t(cleanup) - t(quotesStopped)) / 60_000
			if (m > lateMinutes) lateCleanup = { minutes: Number(m.toFixed(1)) }
		}
	}
	failures.push(...residualFailures('grader read', input.finalCheck))
	if (input.finalCheck.lockPresent) failures.push('the process lock is still held after cleanup (a process may have survived)')

	// --- 7. utility, separately ---------------------------------------------------------
	const fills = lines.filter((l) => l.message === 'fill')
	const utility: SmokeGrade['utility'] = realPlacement && fills.length > 0 ? 'DEMONSTRATED' : 'INCONCLUSIVE'

	const verdict: SmokeVerdict = failures.length ? 'FAIL' : exceptions.length || lateCleanup || readFailures.length ? 'PASS_WITH_DISCLOSED_EXCEPTION' : 'PASS'
	return {
		verdict,
		failures,
		exceptions,
		disclosures: { gasExceptions: exceptions.length, lateCleanup, readFailures },
		utility,
		facts: {
			runId: runId ?? null,
			minutes: minutes === undefined ? null : Number(minutes.toFixed(2)),
			submitted: submitted.length,
			successfulRequotes: successfulRequotes.length,
			fills: fills.length,
			bidFills: fills.filter((l) => l['isBid'] === true).length,
			askFills: fills.filter((l) => l['isBid'] === false).length,
			pausedTicks: lines.filter((l) => l.message === 'quote_paused').length,
			idleTicks: lines.filter((l) => l.message === 'tick_no_submit').length,
			exceptionNetSui: Number(exceptions.reduce((s, e) => s + e.netSui, 0).toFixed(9)),
			settings: start ? Object.fromEntries(SETTINGS.map((k) => [k, start[k] ?? null])) : null,
		},
	}
}

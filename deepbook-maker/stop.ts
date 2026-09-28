/**
 * stop.ts — end the run: cancel every order, sweep settled proceeds, withdraw everything,
 * and verify it on chain.
 *
 *   npm run stop                      # same machine as the loop, or after a crash
 *   npm run stop -- --break-stale-lock  # the loop died and left its lock behind
 *
 * It uses the SAME cleanup as the loop's own exit (`lib/ops.ts` `runCleanup`):
 *
 *   cancelAllOrders → withdrawSettledAmounts → withdrawAllFromManager (base, quote, DEEP)
 *   → receipt → timestamped read: no open order, no settled balance, empty manager
 *
 * `withdrawSettledAmounts` is the step the old stop lacked: if every order had already
 * filled, `cancelAllOrders` had nothing to cancel, never settled, and the proceeds stayed
 * in the pool account.
 *
 * ## It never withdraws under a live loop
 *
 * Stop takes the same account/network/pool lock the loop holds. If a loop on this machine
 * holds it, stop sends that loop SIGTERM and waits for it to finish its tick, run its own
 * cleanup and release the lock — then verifies the result itself. If the holder is on
 * another machine, or its liveness cannot be told, stop refuses: stop that loop where it
 * runs. A dead holder's lock is taken over only with `--break-stale-lock`; pending
 * operations and budgets in the state file are kept either way.
 *
 * Remote recovery (a machine without the loop's state file) needs the manager id:
 * `DEEPBOOK_BALANCE_MANAGER_ID=0x… npm run stop`. The owner comes from the WaaP login.
 */
import { lockKeyFor, openContext, type Context } from './lib/context.ts'
import { defaultLockDir, LockHeldError, lockPathFor, readHolder } from './lib/lock.ts'
import { runCleanup } from './lib/ops.ts'
import { AGENT_ID, DRY_RUN, NETWORK, POOL, POOL_KEY, ZERO_ADDRESS, fatal, log, resolveOwner } from './lib/waap.ts'

if (!POOL) {
	console.error(`[${AGENT_ID}] unknown POOL_KEY ${POOL_KEY} on ${NETWORK}`)
	process.exit(1)
}

const BREAK_STALE = process.argv.includes('--break-stale-lock')
const WAIT_MS = Number(process.env.STOP_WAIT_SEC ?? '600') * 1000

async function open(): Promise<Context> {
	// adopt: a stop may run where no state file exists (remote recovery). It only cleans up.
	return openContext({ purpose: 'stop', adopt: true, breakStale: BREAK_STALE })
}

async function main(): Promise<void> {
	let ctx: Context
	try {
		ctx = await open()
	} catch (err) {
		if (!(err instanceof LockHeldError) || err.status !== 'live' || !err.holder) throw err
		// A live loop on this machine: ask it to stop and clean up, and wait for it.
		log('event', 'stop_handoff', { pid: err.holder.pid, purpose: err.holder.purpose, note: 'sent SIGTERM; waiting for the loop to finish its tick, clean up and release the lock' })
		process.kill(err.holder.pid, 'SIGTERM')
		const owner = await resolveOwner()
		const lockPath = lockPathFor(defaultLockDir(), lockKeyFor(owner))
		const deadline = Date.now() + WAIT_MS
		while (readHolder(lockPath)?.token === err.holder.token) {
			if (Date.now() > deadline) {
				log('error', 'stop_timeout', { pid: err.holder.pid, waitedSec: WAIT_MS / 1000, instruction: 'the loop did not release its lock; check it, then rerun' })
				process.exit(1)
			}
			await new Promise((r) => setTimeout(r, 2_000))
		}
		ctx = await open()
	}

	const recipient = process.env.WITHDRAW_RECIPIENT?.trim() || ctx.owner
	log('event', 'stop_start', { runId: ctx.state.runId ?? null, balanceManagerId: ctx.state.balanceManagerId ?? null, recipient, dryRun: DRY_RUN, owner: ctx.owner })
	if (!ctx.state.balanceManagerId) {
		log('error', 'balance_manager_missing', { note: 'nothing to stop: no manager in state and none in DEEPBOOK_BALANCE_MANAGER_ID' })
		process.exit(1)
	}
	if (recipient === ZERO_ADDRESS) log('warn', 'recipient_is_zero_address', { note: 'dry run with no session; built for byte length only' })

	const r = await runCleanup(ctx, { runId: ctx.state.runId, proc: 'stop', reason: 'operator_stop', recipient })
	log('event', 'stop_done', { dryRun: DRY_RUN, ok: r.ok, digest: r.digest ?? null, alreadyClean: r.alreadyClean ?? false })
	ctx.lock.release()
	process.exit(r.ok ? 0 : 1)
}

main().catch(fatal)

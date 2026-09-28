/**
 * recover.ts — resolve a send whose outcome is unknown, by hand, with evidence.
 *
 *   npm run recover                                     # list pending operations
 *   npm run recover -- attach <opId> <digest>           # the explorer shows it landed
 *   npm run recover -- not-executed <opId> --checked-explorer
 *
 * The loop never guesses an unknown outcome (`lib/pending.ts`). When chain evidence cannot
 * be found automatically — an operation that places no order has no client order id to
 * search for — an operator looks it up on an explorer and records what they found:
 *
 * - `attach` checks that the digest exists, was sent by this account after the operation's
 *   intent, then records it. The loop folds its receipt into the gas budget as usual.
 * - `not-executed` removes the operation. Its gas is unknown, so its whole reservation is
 *   counted as spent, never zero. It requires `--checked-explorer`, and it is logged as an
 *   operator declaration, not as evidence.
 *
 * Takes the same lock as the loop: stop the loop first.
 */
import { foldReceipt } from './lib/budget.ts'
import { openContext } from './lib/context.ts'
import { fatal, log, sui, withRpc } from './lib/waap.ts'

async function main(): Promise<void> {
	const [cmd, opId, arg] = process.argv.slice(2)
	const ctx = await openContext({ purpose: 'recover' })
	const s = ctx.state
	const list = () => s.pending.map((p) => ({ opId: p.opId, kind: p.kind, status: p.status, digest: p.digest ?? null, createdAt: new Date(p.createdAtMs).toISOString(), reservedSui: p.reservedGasMist / 1e9, clientOrderIds: p.clientOrderIds, lastError: p.lastError ?? null }))
	if (!cmd) {
		console.log(JSON.stringify({ owner: ctx.owner, balanceManagerId: s.balanceManagerId ?? null, runId: s.runId ?? null, pending: list() }, null, 2))
		return
	}
	const op = s.pending.find((p) => p.opId === opId)
	if (!op) throw new Error(`no pending operation ${opId}; run \`npm run recover\` to list them`)

	if (cmd === 'attach') {
		if (!arg) throw new Error('attach needs a digest')
		const tx = (await withRpc('getTransactionBlock:recover', () => sui.getTransactionBlock({ digest: arg, options: { showInput: true } }))) as unknown as { timestampMs?: string; transaction?: { data?: { sender?: string } } }
		const sender = tx.transaction?.data?.sender
		if (sender?.toLowerCase() !== ctx.owner.toLowerCase()) throw new Error(`digest ${arg} was sent by ${sender}, not this account ${ctx.owner}`)
		if (Number(tx.timestampMs ?? 0) < op.createdAtMs - 5_000) throw new Error(`digest ${arg} is older than the operation's intent`)
		op.status = 'submitted'
		op.digest = arg
		ctx.save()
		log('event', 'op_resolved', { opId, digest: arg, evidence: 'operator attach: sender and time checked' })
	} else if (cmd === 'not-executed') {
		if (arg !== '--checked-explorer') throw new Error('not-executed requires --checked-explorer: look up this account’s transactions after the intent time first')
		s.budget = foldReceipt(s.budget, { netMist: op.reservedGasMist, status: 'unknown' })
		s.pending = s.pending.filter((p) => p.opId !== opId)
		ctx.save()
		log('event', 'op_declared_not_executed', { opId, kind: op.kind, chargedMist: op.reservedGasMist, note: 'operator declaration after checking an explorer; reservation counted as spent' })
	} else throw new Error(`unknown command ${cmd}`)
	console.log(JSON.stringify({ pending: list() }, null, 2))
	ctx.lock.release()
}

main().catch(fatal)

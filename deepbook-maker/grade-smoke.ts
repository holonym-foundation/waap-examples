/**
 * grade-smoke — grade a live smoke run from its log and the chain.
 *
 *   AGENT_LOG_FILE=./logs/smoke.jsonl npm run -s grade:smoke [-- <runId>]
 *
 * Run it after the loop has exited (its own cleanup, or `npm run stop`). It reads every
 * digest the run submitted, fetches each receipt with its gas budget, reads the manager's
 * open orders, settled balances and manager balances ITSELF (independent of the log), checks
 * the process lock is gone, and hands everything to `gradeSmoke()` in `lib/smoke.ts`,
 * where the rules live. Exit code: 0 for PASS or PASS_WITH_DISCLOSED_EXCEPTION, 1 for FAIL.
 *
 * Read-only: `sui_getTransactionBlock` and DeepBook reads. Nothing is signed, waap-cli
 * is never invoked, and the log is never modified.
 */
import fs from 'node:fs'
import path from 'node:path'

import { gradeSmoke, type LogLine, type SmokeReceipt } from './lib/smoke.ts'
import { parseGasUsed } from './lib/receipts.ts'
import { readResiduals } from './lib/ops.ts'
import { defaultLockDir, lockKey, lockPathFor } from './lib/lock.ts'
import { sui, withRpc } from './lib/waap.ts'

const LOG = process.env.AGENT_LOG_FILE ?? './logs/deepbook-maker.jsonl'
const HERE = path.dirname(new URL(import.meta.url).pathname)

function readLines(file: string): LogLine[] {
	const out: LogLine[] = []
	for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
		const t = raw.trim()
		if (!t.startsWith('{')) continue
		try {
			const o = JSON.parse(t) as LogLine
			if (typeof o.message === 'string' && typeof o.ts === 'string') out.push(o)
		} catch {}
	}
	return out
}

/** Static check: does any shipped source file set a gas budget? */
function codeSetsGasBudget(): boolean {
	const files = [
		...fs.readdirSync(HERE).filter((f) => f.endsWith('.ts')).map((f) => path.join(HERE, f)),
		...fs.readdirSync(path.join(HERE, 'lib')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(HERE, 'lib', f)),
	].filter((f) => !f.endsWith('grade-smoke.ts'))
	return files.some((f) => /\bsetGasBudget\s*\(/.test(fs.readFileSync(f, 'utf8')))
}

async function receiptFor(digest: string): Promise<SmokeReceipt | undefined> {
	try {
		const tx = (await withRpc('getTransactionBlock:grade', () =>
			sui.getTransactionBlock({ digest, options: { showEffects: true, showInput: true } }),
		)) as unknown as { effects?: unknown; transaction?: { data?: { gasData?: { budget?: string } } } }
		const g = parseGasUsed(tx as never, digest)
		if (!g) return undefined
		const budget = tx.transaction?.data?.gasData?.budget
		return { digest, status: g.status, error: g.error, netSui: g.netSui, budgetMist: budget ? Number(budget) : undefined }
	} catch {
		return undefined
	}
}

async function main(): Promise<void> {
	const lines = readLines(LOG)
	const digests = new Set<string>()
	for (const l of lines) {
		if ((l.message === 'tx_submitted' || l.message === 'cleanup_confirmed') && typeof l['digest'] === 'string') digests.add(l['digest'] as string)
	}
	const receipts: Record<string, SmokeReceipt> = {}
	for (const d of digests) {
		const r = await receiptFor(d)
		if (r) receipts[d] = r
	}

	const runId = process.argv[2] ?? (lines.filter((l) => l.message === 'agent_start').at(-1)?.['runId'] as string | undefined)
	const start = lines.find((l) => l.message === 'agent_start' && l['runId'] === runId)
	// Identity comes from the run's own agent_start, never from the local environment.
	const owner = String(start?.['owner'] ?? '')
	const managerId = start?.['balanceManagerId'] as string | undefined
	const residuals = owner && managerId ? await readResiduals(owner, managerId) : {}
	const key = lockKey(owner, String(start?.['network'] ?? ''), String(start?.['poolKey'] ?? ''))
	const lockPresent = !!owner && fs.existsSync(lockPathFor(defaultLockDir(), key))

	const grade = gradeSmoke({
		lines,
		runId,
		receipts,
		finalCheck: { ...residuals, atMs: Date.now(), lockPresent },
		codeSetsGasBudget: codeSetsGasBudget(),
	})

	console.log(JSON.stringify({ log: LOG, managerId, ...grade }, null, 2))
	process.exit(grade.verdict === 'FAIL' ? 1 : 0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

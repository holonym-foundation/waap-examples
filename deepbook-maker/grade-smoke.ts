/**
 * grade-smoke — grade a live smoke run from its log and the chain.
 *
 *   AGENT_LOG_FILE=./logs/smoke.jsonl PID_FILE=./agent.pid npm run -s grade:smoke
 *
 * Run it after the stop sequence (SIGTERM, then `stop.ts`). It reads every digest the
 * log submitted (deposit, requotes, stop), fetches each receipt with its gas budget,
 * reads the manager's open orders and balances, and hands everything to `gradeSmoke()`
 * in `lib/smoke.ts`, where the rules live. Exit code: 0 for PASS or
 * PASS_WITH_DISCLOSED_EXCEPTION, 1 for FAIL.
 *
 * Read-only: `sui_getTransactionBlock` and DeepBook reads. Nothing is signed, waap-cli
 * is never invoked, and the log is never modified.
 */
import fs from 'node:fs'
import path from 'node:path'

import { gradeSmoke, type LogLine, type SmokeReceipt } from './lib/smoke.ts'
import { parseGasUsed } from './lib/receipts.ts'
import { MANAGER_KEY, POOL_KEY, makeDeepBookClient, readBalanceManagerId, sui, withRpc } from './lib/waap.ts'

const LOG = process.env.AGENT_LOG_FILE ?? './logs/deepbook-maker.jsonl'
const PID_FILE = path.resolve(process.env.PID_FILE ?? './agent.pid')
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
		if ((l.message === 'tx_submitted' || l.message === 'stop_done') && typeof l['digest'] === 'string') digests.add(l['digest'] as string)
	}
	const receipts: Record<string, SmokeReceipt> = {}
	for (const d of digests) {
		const r = await receiptFor(d)
		if (r) receipts[d] = r
	}

	const start = lines.find((l) => l.message === 'agent_start')
	const owner = String(start?.['owner'] ?? '')
	const managerId = (start?.['balanceManagerId'] as string | undefined) ?? readBalanceManagerId()
	const stopDone = [...lines].reverse().find((l) => l.message === 'stop_done')

	let openOrders: string[] | undefined
	let managerBase: number | undefined
	let managerQuote: number | undefined
	if (owner && managerId) {
		const db = makeDeepBookClient(owner, managerId)
		try {
			openOrders = (await withRpc('accountOpenOrders:grade', () => db.accountOpenOrders(POOL_KEY, MANAGER_KEY))).map(String)
		} catch {}
		try {
			managerBase = (await withRpc('balance:base:grade', () => db.checkManagerBalance(MANAGER_KEY, 'DEEP'))).balance
			managerQuote = (await withRpc('balance:quote:grade', () => db.checkManagerBalance(MANAGER_KEY, 'SUI'))).balance
		} catch {}
	}

	const grade = gradeSmoke({
		lines,
		receipts,
		afterStop: {
			stopDigest: stopDone?.['digest'] as string | undefined,
			openOrders,
			managerBase,
			managerQuote,
			pidFilePresent: fs.existsSync(PID_FILE),
		},
		codeSetsGasBudget: codeSetsGasBudget(),
	})

	console.log(JSON.stringify({ log: LOG, managerId, ...grade }, null, 2))
	process.exit(grade.verdict === 'FAIL' ? 1 : 0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

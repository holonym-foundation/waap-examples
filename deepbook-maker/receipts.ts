/**
 * receipts — fetch the effects for every digest a run submitted, and total the gas.
 *
 *   AGENT_LOG_FILE=./logs/live-24h.jsonl npm run -s receipts
 *
 * The loop records gas as it goes (`tx_gas` lines, see `agent.ts`). This is the
 * after-the-fact path: it reads `tx_submitted` out of a log, fetches each receipt with
 * `showEffects: true`, and prints the per-kind gas table. Use it to backfill
 * a run whose `tx_gas` lines are missing — a receipt read can fail while the submission
 * succeeds, and a missing receipt must be visible as a gap rather than counted as zero.
 *
 * Read-only: `sui_getTransactionBlock` and nothing else. Nothing is signed, waap-cli is
 * never invoked, and the log is never modified.
 *
 * `--json` prints the rows as JSONL instead of a table.
 */
import fs from 'node:fs'

import { parseGasUsed, totalGas, type GasReceipt } from './lib/receipts.ts'
import { fetchReceipt } from './lib/waap.ts'

const LOG = process.env.AGENT_LOG_FILE ?? './logs/deepbook-maker.jsonl'
const AS_JSON = process.argv.includes('--json')

interface Submitted {
	digest: string
	kind: string
	tick?: number
	ts?: string
}

function readSubmissions(file: string): Submitted[] {
	const out: Submitted[] = []
	const seen = new Set<string>()
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue
		let row: Record<string, unknown>
		try {
			row = JSON.parse(line) as Record<string, unknown>
		} catch {
			continue
		}
		if (row.message !== 'tx_submitted') continue
		const digest = String(row.digest ?? '')
		if (!digest || seen.has(digest)) continue
		seen.add(digest)
		out.push({ digest, kind: String(row.kind ?? '—'), tick: row.tick as number | undefined, ts: row.ts as string | undefined })
	}
	return out
}

async function main() {
	if (!fs.existsSync(LOG)) {
		console.error(`no such log: ${LOG} — set AGENT_LOG_FILE`)
		process.exit(1)
	}
	const submissions = readSubmissions(LOG)
	if (submissions.length === 0) {
		console.error(`no tx_submitted lines in ${LOG}`)
		process.exit(1)
	}

	const rows: Array<Submitted & { gas: GasReceipt | null }> = []
	for (const s of submissions) {
		const receipt = await fetchReceipt(s.digest)
		rows.push({ ...s, gas: parseGasUsed(receipt, s.digest) })
	}

	if (AS_JSON) {
		for (const r of rows) console.log(JSON.stringify(r))
		return
	}

	const found = rows.filter((r) => r.gas).map((r) => r.gas!)
	const missing = rows.filter((r) => !r.gas)

	console.log(`log: ${LOG} · submissions: ${rows.length} · receipts read: ${found.length} · missing: ${missing.length}`)
	console.log('')
	console.log('| tick | kind | digest | status | computation | storage | rebate | net SUI | gross SUI |')
	console.log('|---|---|---|---|---|---|---|---|---|')
	for (const r of rows) {
		const g = r.gas
		console.log(
			`| ${r.tick ?? '—'} | ${r.kind} | ${r.digest.slice(0, 8)}… | ${g?.status ?? 'NO RECEIPT'} | ${g?.computationMist ?? '—'} | ${g?.storageMist ?? '—'} | ${g?.rebateMist ?? '—'} | ${g ? g.netSui.toFixed(9) : '—'} | ${g ? g.grossSui.toFixed(9) : '—'} |`,
		)
	}

	const t = totalGas(found)
	console.log('')
	console.log(`total net:  ${t.netSui.toFixed(9)} SUI over ${t.count} receipts`)
	console.log(`total gross: ${t.grossSui.toFixed(9)} SUI`)
	console.log(`per transaction: mean ${t.meanNetSui.toFixed(9)} · min ${t.minNetSui.toFixed(9)} · max ${t.maxNetSui.toFixed(9)} SUI`)
	if (t.failed) console.log(`FAILED transactions: ${t.failed} (they burned gas and are in the totals)`)
	if (missing.length) {
		console.log('')
		console.log(`MISSING RECEIPTS (${missing.length}) — their cost is unknown, NOT zero:`)
		for (const m of missing) console.log(`  ${m.kind} ${m.digest}`)
	}

	// By kind, because the shapes do not cost the same.
	const byKind = new Map<string, GasReceipt[]>()
	for (const r of rows) if (r.gas) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.gas])
	console.log('')
	console.log('| kind | n | total net SUI | mean net SUI | min | max |')
	console.log('|---|---|---|---|---|---|')
	for (const [kind, list] of byKind) {
		const k = totalGas(list)
		console.log(`| ${kind} | ${k.count} | ${k.netSui.toFixed(9)} | ${k.meanNetSui.toFixed(9)} | ${k.minNetSui.toFixed(9)} | ${k.maxNetSui.toFixed(9)} |`)
	}
}

main().catch((err) => {
	console.error(String(err))
	process.exit(1)
})

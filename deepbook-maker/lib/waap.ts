/**
 * Shared runtime for every script in this recipe: the waap-cli signing spine, the
 * logger, the Sui and DeepBook clients, and the PTB serialiser.
 *
 * It lives in one file so `agent.ts`, `deposit.ts`, `stop.ts` and `refuse-probe.ts`
 * all leave through the SAME `signAndSendTx` — one dry-run guard, one send-tx call
 * counter, one place a key could have been and is not.
 *
 * `parseWaapJson`, `signAndSendTx` and `whoami` are copied from waap-docs
 * `content/recipes/sui-portfolio-rebalancer.mdx` :324-363. The only change is the
 * DRY_RUN guard at the top of `signAndSendTx` and the `sendTxCalls` counter, which is
 * incremented only on the real path.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'

import { DeepBookClient, FLOAT_SCALAR, mainnetCoins, mainnetPools, testnetCoins, testnetPools } from '@mysten/deepbook-v3'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Transaction } from '@mysten/sui/transactions'
import { execa } from 'execa'
import { Agent, fetch as undiciFetch } from 'undici'

import type { PoolScalars } from './events.ts'
import { cursorAtTime, getTransaction, indexerFillQuery, ownerTransactions, type ChainTx, type FillCursor } from './chain.ts'
import type { EventCursor, QueryEvents } from './fills.ts'
import type { RpcReceipt } from './receipts.ts'

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

export const AGENT_ID = 'deepbook-maker'

export const NETWORK = (process.env.NETWORK ?? 'mainnet') as 'mainnet' | 'testnet'

// Reads go over Sui gRPC (DeepBook SDK, transaction building, balances) and Sui
// GraphQL (receipts, events, an owner's transactions). Public JSON-RPC is retired:
// see the header of lib/chain.ts for what failed and when. waap-cli signs over the
// same public gRPC endpoint.
const DEFAULT_GRPC: Record<string, string> = {
	mainnet: 'https://fullnode.mainnet.sui.io:443',
	testnet: 'https://fullnode.testnet.sui.io:443',
}
const DEFAULT_GRAPHQL: Record<string, string> = {
	mainnet: 'https://graphql.mainnet.sui.io/graphql',
	testnet: 'https://graphql.testnet.sui.io/graphql',
}
const DEFAULT_INDEXER: Record<string, string> = {
	mainnet: 'https://deepbook-indexer.mainnet.mystenlabs.com',
	testnet: 'https://deepbook-indexer.testnet.mystenlabs.com',
}
/**
 * `SUI_RPC` is the pre-October JSON-RPC setting. It is still read, but only when it is
 * a gRPC endpoint: an `.env` copied from an older version that points it at publicnode
 * must not send gRPC calls to a JSON-RPC host. `SUI_GRPC` wins when both are set.
 */
const LEGACY_SUI_RPC = process.env.SUI_RPC?.trim()
export const LEGACY_RPC_IGNORED = !!LEGACY_SUI_RPC && !process.env.SUI_GRPC?.trim() && !/fullnode\.[a-z]+\.sui\.io/.test(LEGACY_SUI_RPC)
export const SUI_RPC =
	process.env.SUI_GRPC?.trim() || (LEGACY_SUI_RPC && !LEGACY_RPC_IGNORED ? LEGACY_SUI_RPC : '') || DEFAULT_GRPC[NETWORK] || DEFAULT_GRPC.mainnet
export const SUI_GRAPHQL = process.env.SUI_GRAPHQL?.trim() || DEFAULT_GRAPHQL[NETWORK] || DEFAULT_GRAPHQL.mainnet
export const DEEPBOOK_INDEXER = process.env.DEEPBOOK_INDEXER?.trim() || DEFAULT_INDEXER[NETWORK] || DEFAULT_INDEXER.mainnet

/**
 * Fallback gRPC endpoints, tried in order after the primary when one fails in a way
 * that is the NODE's fault. A single `fetch failed` ended ticks 5 and 6 of the first
 * live run; five in a row exits the process.
 *
 * No default: Mysten's public endpoint is the only free one we have verified (the old
 * JSON-RPC fallbacks, Suiscan and rpcpool, both went dark). `SUI_GRPC_FALLBACKS`
 * (comma-separated) adds yours; every read still retries 3 times on the primary alone.
 */
const DEFAULT_FALLBACKS: Record<string, string[]> = { mainnet: [], testnet: [] }
export const RPC_ENDPOINTS: string[] = (() => {
	const fromEnv = process.env.SUI_GRPC_FALLBACKS
	const fallbacks =
		fromEnv === undefined
			? (DEFAULT_FALLBACKS[NETWORK] ?? [])
			: fromEnv
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
	// The primary always leads, and never appears twice — pointing it at a fallback
	// must not make the rotation try the same dead host twice in a row.
	return [SUI_RPC, ...fallbacks.filter((u) => u !== SUI_RPC)]
})()

export const POOL_KEY = process.env.POOL_KEY ?? 'DEEP_SUI'

export const ENV_BALANCE_MANAGER_ID = process.env.DEEPBOOK_BALANCE_MANAGER_ID?.trim() || undefined

const LOG_FILE = path.resolve(process.env.AGENT_LOG_FILE ?? `./logs/${AGENT_ID}.jsonl`)
// ./logs is not created by `npm init`. appendFileSync throws ENOENT on a missing
// directory and the logger swallows it, so the symptom would be silence.
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })

/** Default ON. Going live requires AGENT_DRY_RUN=0 explicitly. */
export const DRY_RUN = process.env.AGENT_DRY_RUN !== '0'

/**
 * Live and dry runs never share a state file: a dry run's simulated orders and zero
 * budgets must not be read back by a live run (the rotator mixed them). The mode is also
 * part of the state's identity, so pointing both at one file fails loudly.
 */
export const STATE_FILE = path.resolve(process.env.STATE_FILE ?? (DRY_RUN ? './state.dry.json' : './state.json'))
export const RUN_MODE: 'live' | 'dry' = DRY_RUN ? 'dry' : 'live'

/** The SDK addresses a BalanceManager by key, not by id. One manager, one key. */
export const MANAGER_KEY = 'MAKER'

/** Used for logging only when there is no session and nothing will be signed. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000'

const POOLS = NETWORK === 'mainnet' ? mainnetPools : testnetPools
const COINS = NETWORK === 'mainnet' ? mainnetCoins : testnetCoins

export const POOL = POOLS[POOL_KEY]

/**
 * The scalars every on-chain integer in this pool is scaled by. Read from the SDK's
 * own constants rather than hardcoded — see SDK-NOTES §D for the formula.
 * DEEP/SUI on mainnet: floatScalar 1e9, baseScalar 1e6 (DEEP), quoteScalar 1e9 (SUI).
 */
export function poolScalars(): PoolScalars {
	return {
		floatScalar: FLOAT_SCALAR,
		baseScalar: COINS[POOL.baseCoin].scalar,
		quoteScalar: COINS[POOL.quoteCoin].scalar,
	}
}

// -----------------------------------------------------------------------------
// Logging — JSON line to stdout and to the log file.
// -----------------------------------------------------------------------------

export function log(level: string, message: string, data: Record<string, unknown> = {}) {
	const entry = { ts: new Date().toISOString(), agent: AGENT_ID, level, message, ...data }
	const line = JSON.stringify(entry)
	console.log(line)
	try {
		fs.appendFileSync(LOG_FILE, line + '\n')
	} catch {}
}

/** Exit 1 with a `fatal` line, for the top-level catch in every script. */
export function fatal(err: unknown): never {
	log('error', 'fatal', { error: err instanceof Error ? err.message : String(err), sendTxCalls })
	process.exit(1)
}

// -----------------------------------------------------------------------------
// waap-cli spine — copied from sui-portfolio-rebalancer.mdx :324-363.
// -----------------------------------------------------------------------------

/** Number of times waap-cli send-tx was actually invoked. Must be 0 in a dry run. */
let sendTxCalls = 0
export function getSendTxCalls(): number {
	return sendTxCalls
}

/**
 * Sends waap-cli refused before anything was signed or submitted — a policy rejection,
 * or a build the backend rejected (`SUI_BUILD_REJECTED` ×20 on 2026-09-25). `sendTxCalls`
 * counts attempts, so for one process `sendTxCalls - sendTxRefused` = `tx_submitted`.
 */
let sendTxRefused = 0
export function getSendTxRefused(): number {
	return sendTxRefused
}

/**
 * The raw output of the last real `waap-cli send-tx`. Kept so `refuse-probe.ts` can log
 * the policy engine's whole answer — including a refusal, which has no digest in it.
 * Null in a dry run, because waap-cli was never invoked.
 *
 * **This is the refusal-evidence path, and it used to lose the evidence.** The
 * assignment `lastSendTxStdout = stdout` sat AFTER `await execa(...)`, so it ran only
 * when the CLI exited zero. A policy rejection that exits nonzero makes execa throw,
 * the assignment never runs, and `refuse-probe.ts` logs `response: null` — the one line
 * the policy probe is graded on, empty in exactly the case the policy probe is about. The send is now wrapped so
 * both stdout and stderr survive a nonzero exit, and the error is rethrown unchanged so
 * every other caller behaves as before.
 */
let lastSendTxStdout: string | null = null
export function getLastSendTxStdout(): string | null {
	return lastSendTxStdout
}

/** What the last real `waap-cli send-tx` invocation did, refusal included. */
export interface SendTxResult {
	ok: boolean
	exitCode: number | null
	stdout: string | null
	stderr: string | null
	/** execa's own summary line when the process failed. */
	message: string | null
}

let lastSendTxResult: SendTxResult | null = null
export function getLastSendTxResult(): SendTxResult | null {
	return lastSendTxResult
}

export function parseWaapJson<T>(stdout: string): T {
	const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
	for (const line of lines) {
		try {
			const obj = JSON.parse(line) as { event?: string }
			if (obj.event === 'result') return obj as T
		} catch {}
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]) as T
		} catch {}
	}
	throw new Error(`Could not parse waap-cli JSON: ${stdout.slice(0, 200)}`)
}

export async function signAndSendTx(b64TxBytes: string, kind: string): Promise<string | null> {
	if (DRY_RUN) {
		log('info', 'dry_run_skip', { kind, bytesLen: b64TxBytes.length, sendTxCalls })
		return null
	}
	sendTxCalls++
	lastSendTxStdout = null
	lastSendTxResult = null
	let stdout: string
	try {
		const res = await execa(
			'waap-cli',
			['send-tx', '--tx', b64TxBytes, '--tx-format', 'base64', '--chain', `sui:${NETWORK}`, '--json'],
			// `detached`: its own process group, so a terminal Ctrl-C reaches the agent (which
			// finishes the tick) and not the in-flight signing call (review #7).
			{ timeout: 120_000, detached: true },
		)
		stdout = res.stdout
		lastSendTxStdout = stdout
		lastSendTxResult = { ok: true, exitCode: 0, stdout, stderr: res.stderr ?? null, message: null }
	} catch (err) {
		// A nonzero exit is an ANSWER on this path, not only a failure: it is what a
		// policy rejection looks like. Keep every channel it could have spoken on before
		// rethrowing, so `policy_probe` has something to show either way.
		const e = err as { stdout?: string; stderr?: string; exitCode?: number; shortMessage?: string; message?: string }
		const captured = [e.stdout, e.stderr].filter((s) => typeof s === 'string' && s.length > 0).join('\n')
		lastSendTxStdout = captured || null
		lastSendTxResult = {
			ok: false,
			exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
			stdout: e.stdout ?? null,
			stderr: e.stderr ?? null,
			message: e.shortMessage ?? e.message ?? String(err),
		}
		sendTxRefused++
		throw err
	}
	// Live: a send either yields a digest or is a failure. Never return null here —
	// callers read null as "dry run" and would record orders that were never placed.
	// waap-cli can print `{"event":"error"}` and still exit 0, so the stream decides.
	const digest = digestFromCliStdout(stdout)
	if (!digest) {
		sendTxRefused++
		const err = cliErrorEvent(stdout)
		throw new Error(
			err
				? `waap-cli error (exit 0): ${err.code ?? 'UNKNOWN'}: ${err.message ?? ''}`.trim()
				: `waap-cli returned no transaction digest (exit 0): ${stdout.slice(0, 200)}`,
		)
	}
	return digest
}

/** The `{"event":"error"}` line in waap-cli's NDJSON stream, if any. */
export function cliErrorEvent(stdout: string): { code?: string; message?: string } | null {
	for (const line of stdout.split(/\r?\n/)) {
		const t = line.trim()
		if (!t.startsWith('{')) continue
		try {
			const o = JSON.parse(t) as { event?: string; code?: string; message?: string }
			if (o.event === 'error') return o
		} catch {}
	}
	return null
}

/**
 * The digest of a successful send, or null. Only a `result` event carries one; an
 * `error` event with no `result` is a failure whatever the exit code.
 */
export function digestFromCliStdout(stdout: string): string | null {
	for (const line of stdout.split(/\r?\n/)) {
		const t = line.trim()
		if (!t.startsWith('{')) continue
		try {
			const o = JSON.parse(t) as { event?: string; txHash?: string; digest?: string }
			if (o.event === 'result') return o.txHash ?? o.digest ?? null
		} catch {}
	}
	if (cliErrorEvent(stdout)) return null
	const m = stdout.match(/(?:Transaction submitted|TxHash|digest):\s*(\S+)/i)
	return m ? m[1] : null
}

export async function whoami(): Promise<string> {
	const override = process.env.WAAP_AGENT_ADDRESS?.trim()
	if (override) return override

	const { stdout } = await execa('waap-cli', ['whoami', '--json'])
	const parsed = parseWaapJson<{ suiWalletAddress?: string }>(stdout)
	if (!parsed.suiWalletAddress) {
		throw new Error('No Sui wallet — run `waap-cli signup` first')
	}
	return parsed.suiWalletAddress
}

/**
 * In a dry run nothing is signed, so no session is needed. Fall back to the zero
 * address, which is used for logging only — the PTB is serialised with
 * `onlyTransactionKind: true` and carries no sender.
 */
export async function resolveOwner(): Promise<string> {
	if (process.env.WAAP_AGENT_ADDRESS?.trim()) return whoami()
	if (DRY_RUN) {
		log('info', 'dry_run_no_session', {
			note: 'no WAAP_AGENT_ADDRESS and dry run is on; using the zero address for logging only',
		})
		return ZERO_ADDRESS
	}
	return whoami()
}

// -----------------------------------------------------------------------------
// Clients and PTB serialisation
// -----------------------------------------------------------------------------

/**
 * The HTTP connection pool behind every RPC read, and why it is ours.
 *
 * The SDK's transports call `options.fetch ?? fetch`, and Node's global `fetch` keeps ONE
 * connection pool for the whole process. Rotating to a new client therefore never touched
 * a single socket. Live run 2b
 * (28 Sep, 15:45–15:50Z): four ticks got `fetch failed` from both endpoints while a fresh
 * Node process on the same Mac reached them — the signature of process-local state. The
 * exact cause was not recorded (the log kept only undici's opaque message; `rpc_retry`
 * now keeps `cause`). So on every endpoint failure the pool is replaced before the
 * retry, and requests are bounded (connect 10 s, headers and body 30 s each) instead of
 * undici's 300 s defaults. `rpcFetch` reads `rpcAgent` per request, so a DeepBookClient
 * built before a recycle uses the fresh pool too.
 */
const newRpcAgent = () => new Agent({ connect: { timeout: 10_000 }, headersTimeout: 30_000, bodyTimeout: 30_000 })
let rpcAgent = newRpcAgent()
const rpcFetch = ((input: string | URL | Request, init?: RequestInit) =>
	undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: rpcAgent })) as unknown as typeof fetch

function newSuiClient(url: string): SuiGrpcClient {
	return new SuiGrpcClient({ baseUrl: url, network: NETWORK, fetch: rpcFetch })
}

/** JSON over HTTP on the same bounded pool, for GraphQL and the DeepBook indexer. */
async function httpJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await rpcFetch(url, init)
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${hostOf(url)}`)
	return res.json()
}
const postJson = (url: string, body: unknown) => httpJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const getJson = (url: string) => httpJson(url)

/**
 * The Sui client. `let`, not `const`, because a dead endpoint is rotated away from at
 * runtime — and an ES module export is a live binding, so `import { sui }` in
 * `agent.ts` sees the replacement without any re-import.
 *
 * Anything that HOLDS the client rather than reading it through this binding is stale
 * after a rotation. That is exactly the DeepBookClient, which takes `client` in its
 * constructor: use `onRpcRotated` to rebuild it. See `withRpc`.
 */
export let sui = newSuiClient(RPC_ENDPOINTS[0])

/** Replace the connection pool; the old one finishes in-flight requests, then closes. */
export function recycleRpcConnections(reason: string): void {
	const old = rpcAgent
	rpcAgent = newRpcAgent()
	old.close().catch(() => {})
	log('event', 'rpc_connections_recycled', { reason })
}

/** The chain of `cause`s under an error (undici hides the real one: UND_ERR_*, ECONNRESET, EMFILE…). */
export function errorCause(err: unknown): string | null {
	const parts: string[] = []
	let c = (err as { cause?: unknown })?.cause
	for (let i = 0; c && i < 4; i++) {
		const e = c as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
		parts.push([e.code, e.name, e.message].filter((x) => x !== undefined && x !== '').join(' ') || String(c))
		c = e.cause
	}
	return parts.length ? parts.join(' <- ').slice(0, 300) : null
}

let rpcIndex = 0

/** The endpoint the client is pointed at right now. */
export function currentRpcUrl(): string {
	return RPC_ENDPOINTS[rpcIndex]
}

/** Host only, for log lines that should not repeat the scheme on every retry. */
function hostOf(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

type RotationListener = (client: SuiGrpcClient, url: string) => void
const rotationListeners = new Set<RotationListener>()

/**
 * Register a callback fired after every rotation, and get back the unsubscribe.
 * Every holder of a DeepBookClient must register one: the DeepBookClient captures the
 * Sui client at construction, so it keeps talking to the dead host otherwise. Rebuild
 * it through `makeDeepBookClient`, which is the single place the manager key and the
 * balanceManagers config (address, and the tradeCap slot this recipe leaves empty) are
 * set — so a rebuild cannot drift from the original.
 */
export function onRpcRotated(fn: RotationListener): () => void {
	rotationListeners.add(fn)
	return () => {
		rotationListeners.delete(fn)
	}
}

/** Move to the next endpoint in the ring and rebuild the client. False if there is only one. */
export function rotateRpc(): boolean {
	if (RPC_ENDPOINTS.length < 2) return false
	const from = currentRpcUrl()
	rpcIndex = (rpcIndex + 1) % RPC_ENDPOINTS.length
	const to = currentRpcUrl()
	sui = newSuiClient(to)
	log('event', 'rpc_rotated', { from, to })
	for (const fn of rotationListeners) {
		try {
			fn(sui, to)
		} catch (err) {
			log('warn', 'rpc_rotation_listener_failed', { error: String(err).slice(0, 200) })
		}
	}
	return true
}

/**
 * Is this the endpoint's fault rather than the request's?
 *
 * The line to hold: an error about THIS NODE earns a rotation, an error about the
 * REQUEST does not. Asking a second node the same bad question — an input object that
 * does not exist, a digest nobody has — only burns a second node, and would turn one
 * bad manager id into three `rpc_rotated` lines and a 13 s wait per tick.
 *
 * Two families count as the node's fault:
 *
 * 1. Transport. `fetch failed` is undici's opaque wrapper for DNS, TLS, connection
 *    reset and timeout alike, and is the one that ended ticks 5 and 6 of the live run —
 *    it carries no detail at all, which is why the match list below is broad.
 * 2. **JSON-RPC -32601, "method not found".** The node answered, so this is not
 *    transport — but what it answered is that it does not serve this API. That is the
 *    Mysten public fullnode since it retired JSON-RPC (SDK-NOTES §A2), and it is a
 *    property of the endpoint, not of the call. Rotating is exactly right; retrying is
 *    exactly useless. Without this, the documented dead endpoint fails the tick on
 *    attempt 1 and never reaches a fallback that works.
 *
 * Everything else — an invalid input object, an insufficient balance, an unknown
 * digest — is rethrown on the first attempt, unretried and unrotated.
 */
export function isEndpointFailure(err: unknown): boolean {
	const raw = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err)
	const msg = raw.toLowerCase()
	const code = (err as { code?: unknown })?.code
	return (
		msg.includes('fetch failed') ||
		msg.includes('econnreset') ||
		msg.includes('econnrefused') ||
		msg.includes('etimedout') ||
		msg.includes('enotfound') ||
		msg.includes('eai_again') ||
		msg.includes('socket hang up') ||
		msg.includes('network') ||
		msg.includes('timeout') ||
		// 401/403: the endpoint refuses us. It will not start answering on a retry, so
		// rotate (25 Sep: rpcpool answered 403 to every call and ended the run).
		/\b(401|403|429|502|503|504)\b/.test(msg) ||
		// The endpoint does not serve this API.
		code === -32601 ||
		msg.includes('-32601') ||
		msg.includes('method not found') ||
		msg.includes('json-rpc on public fullnodes has been deprecated') ||
		// gRPC status codes for a node that cannot serve us right now.
		/\b(unavailable|deadline_exceeded|resource_exhausted)\b/.test(msg)
	)
}

/**
 * 3 attempts, 1 s / 3 s / 9 s backoff. The third wait runs after the last attempt has
 * failed and the client has already been rotated, so the caller — the tick loop, which
 * then sleeps its own POLL_MS — resumes on a rested endpoint rather than hammering the
 * one that just died.
 */
const RPC_ATTEMPTS = Number(process.env.RPC_ATTEMPTS ?? '3')
const RPC_BACKOFF_MS = [1_000, 3_000, 9_000]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wrap one RPC read. Every read in this recipe goes through here.
 *
 * `fn` must read `sui` (or a rebuilt DeepBookClient) at call time, not close over a
 * client captured before the first attempt — that is the whole point of the rotation.
 * Write `withRpc('book', () => db.getLevel2TicksFromMid(...))`, never
 * `withRpc('book', ((c) => () => c.getLevel2...)(sui))`.
 */
export async function withRpc<T>(
	op: string,
	fn: () => Promise<T>,
	opts: { attempts?: number; backoffMs?: number[] } = {},
): Promise<T> {
	const attempts = Math.max(1, opts.attempts ?? RPC_ATTEMPTS)
	const backoff = opts.backoffMs ?? RPC_BACKOFF_MS
	let lastErr: unknown

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			const endpointFault = isEndpointFailure(err)
			log('warn', 'rpc_retry', {
				attempt,
				host: hostOf(currentRpcUrl()),
				error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
				cause: errorCause(err),
				op,
				attempts,
				endpointFailure: endpointFault,
			})
			// An error about the request, not about the node: no retry, no rotation.
			if (!endpointFault) throw err
			recycleRpcConnections(`${op}: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`)
			rotateRpc()
			await sleep(backoff[Math.min(attempt, backoff.length) - 1])
		}
	}
	throw lastErr
}

export function makeDeepBookClient(owner: string, balanceManagerId?: string): DeepBookClient {
	return new DeepBookClient({
		client: sui,
		address: owner,
		network: NETWORK,
		balanceManagers: balanceManagerId ? { [MANAGER_KEY]: { address: balanceManagerId } } : {},
	})
}

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64')
}

/**
 * Serialise a PTB to the base64 kind bytes `waap-cli send-tx --tx-format base64`
 * takes. Returns null and logs `tx_build_failed` when the SDK cannot resolve an
 * input object (the usual cause is a BalanceManager id that does not exist on chain).
 */
export async function buildKindBytes(
	tx: Transaction,
	kind: string,
	extra: Record<string, unknown> = {},
): Promise<string | null> {
	try {
		// `tx.build` is an RPC read: it resolves every input object through the node, so
		// a dead endpoint shows up here as `tx_build_failed` and a silently skipped tick.
		// `sui` is read inside the closure so a rotation mid-build is picked up.
		const bytes = await withRpc('tx_build', () => tx.build({ client: sui, onlyTransactionKind: true }))
		const b64 = toBase64(bytes)
		log('event', 'tx_built', { kind, bytesLen: bytes.length, b64Len: b64.length, ...extra })
		return b64
	} catch (err) {
		log('error', 'tx_build_failed', { kind, error: String(err).slice(0, 300), ...extra })
		return null
	}
}

// -----------------------------------------------------------------------------
// Read-only chain queries the measurement paths need
// -----------------------------------------------------------------------------

/**
 * A transaction by digest, with events, object changes and effects, in the JSON-RPC
 * shape the rest of the recipe reads. Over Sui GraphQL; see lib/chain.ts.
 */
export function fetchChainTx(digest: string): Promise<ChainTx> {
	return getTransaction(postJson, SUI_GRAPHQL, digest)
}

/**
 * A `QueryEvents` for `walkFills` that finds THIS manager's fills: the DeepBook indexer
 * names the transactions, GraphQL supplies the events. See lib/chain.ts.
 */
export function fillQueryFor(managerId: string): QueryEvents {
	const q = indexerFillQuery({ get: getJson, post: postJson, indexerUrl: DEEPBOOK_INDEXER, graphqlUrl: SUI_GRAPHQL, poolKey: POOL_KEY, managerId })
	return (args) => withRpc('fills:indexer', () => q(args))
}

/**
 * The fill cursor at a wall-clock instant. The walk resumes from that time; the indexer
 * is queried by time, so no event lookup is needed.
 */
export async function anchorCursorAt(timeMs: number, _windowMs = 60_000): Promise<EventCursor | null> {
	return cursorAtTime(timeMs)
}

/**
 * A transaction's receipt WITH EFFECTS — which is where `gasUsed` lives and which the
 * loop's own `fetchTx` does not ask for. Returns null rather than throwing so a missing
 * receipt is reported as a gap instead of ending a run.
 */
export async function fetchReceipt(digest: string, attempts = 4): Promise<RpcReceipt | null> {
	for (let i = 0; i < attempts; i++) {
		try {
			const tx = await withRpc(
				'getTransactionBlock:effects',
				() => fetchChainTx(digest),
				{ attempts: 2, backoffMs: [1_000, 1_000] },
			)
			return tx as unknown as RpcReceipt
		} catch (err) {
			if (i === attempts - 1) {
				log('warn', 'receipt_fetch_failed', { digest, attempts, error: String(err).slice(0, 200) })
				return null
			}
			await sleep(1000 * (i + 1))
		}
	}
	return null
}

/**
 * Our address's transactions since `sinceMs`, newest first, with the client order ids of
 * every `OrderPlaced` they emitted — the evidence `resolveUnknown` needs. `complete` is
 * false when the page ran out before reaching `sinceMs`.
 */
export async function recentOwnerTxs(owner: string, sinceMs: number, limit = 50): Promise<{ txs: Array<{ digest: string; timestampMs: number; clientOrderIds: string[] }>; complete: boolean }> {
	const page = await withRpc('transactions:owner', () => ownerTransactions(postJson, SUI_GRAPHQL, owner, limit))
	const txs = page.data.map((t) => ({
		digest: t.digest,
		timestampMs: Number(t.timestampMs ?? 0),
		clientOrderIds: (t.events ?? []).filter((e) => e.type.endsWith('::order_info::OrderPlaced')).map((e) => String((e.parsedJson as Record<string, unknown> | undefined)?.client_order_id ?? '')),
	}))
	const oldest = txs.at(-1)?.timestampMs ?? 0
	return { txs, complete: !page.hasNextPage || oldest < sinceMs }
}

/** The fill cursor at "now" — a start point for a walk that must not begin in the past. */
export async function headCursor(_eventType?: string): Promise<FillCursor | null> {
	return cursorAtTime(Date.now())
}

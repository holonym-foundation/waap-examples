/**
 * Chain reads that are not DeepBook SDK calls: receipts, events, an owner's recent
 * transactions, and where our fills are.
 *
 * ## Why not JSON-RPC
 *
 * Until October 2026 every read here was Sui JSON-RPC (`sui_getTransactionBlock`,
 * `suix_queryEvents`, `suix_queryTransactionBlocks`). Mysten's public fullnodes retired
 * it (-32601 "JSON-RPC on public fullnodes has been deprecated"), and the free
 * endpoints that still served it went with it. On 2026-10-23 none of twelve answered:
 * publicnode `-32701 no available nodes`, Suiscan 404, BlockVision "deprecated, migrate
 * to gRPC or GraphQL", Blast 403, Tatum "no healthy upstream". Publicnode had also
 * pruned the 28 September effects the ledger proof needs.
 *
 * So the recipe reads the way Mysten now serves the chain:
 *
 *   • gRPC (`SuiGrpcClient`, `lib/waap.ts`) for everything the DeepBook SDK and
 *     `Transaction.build` need — they only use the transport-neutral `client.core` API.
 *     waap-cli itself signs over the same public gRPC endpoint.
 *   • GraphQL (this file) for receipts with decoded events and object changes, and for
 *     an owner's transactions. gRPC returns event contents as BCS only.
 *   • DeepBook's public indexer (this file) to FIND our fills. A maker's fill lands in
 *     someone else's transaction, and neither gRPC nor GraphQL can filter events by a
 *     field inside them. The indexer is only the finder: every fill it names is re-read
 *     from chain through GraphQL, and its identity is the chain's own
 *     `txDigest:eventSeq`, so nothing the indexer says reaches the ledger unchecked.
 *
 * Every function returns the JSON-RPC shapes the rest of the recipe already consumes
 * (`RpcTransactionBlock`, `RpcReceipt`, `EventPage`), so `events.ts`, `receipts.ts`,
 * manager setup, the budget and their tests are unchanged.
 */
import type { RpcEvent, RpcObjectChange, RpcTransactionBlock } from './events.ts'
import type { EventCursor, EventPage, QueriedEvent, QueryEvents } from './fills.ts'
import type { RpcReceipt } from './receipts.ts'

/** POST a JSON body, return the parsed JSON. Injected so tests need no network. */
export type PostJson = (url: string, body: unknown) => Promise<unknown>
/** GET a URL, return the parsed JSON. */
export type GetJson = (url: string) => Promise<unknown>

/** A receipt with everything the loop, recovery and the smoke grader read from it. */
export interface ChainTx extends RpcTransactionBlock, RpcReceipt {
	digest: string
	checkpoint?: string
	events: QueriedEvent[]
	objectChanges: RpcObjectChange[]
	transaction: { data: { sender?: string; gasData: { budget?: string } } }
}

const TX_FIELDS = `digest
	sender { address }
	gasInput { gasBudget }
	effects {
		status timestamp checkpoint { sequenceNumber } executionError { message }
		gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
		objectChanges(first: 50) { nodes { address idCreated idDeleted outputState { asMoveObject { contents { type { repr } } } } } }
		events(first: 50) { nodes { sequenceNumber contents { type { repr } json } sender { address } } }
	}`

export async function gql<T>(post: PostJson, url: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = (await post(url, { query, variables })) as { data?: T; errors?: unknown }
	if (res?.errors) throw new Error(`graphql error: ${JSON.stringify(res.errors).slice(0, 300)}`)
	if (!res?.data) throw new Error('graphql: empty response')
	return res.data
}

interface GqlTx {
	digest: string
	sender?: { address?: string } | null
	gasInput?: { gasBudget?: string | number } | null
	effects?: {
		status?: string
		timestamp?: string
		checkpoint?: { sequenceNumber?: number | string } | null
		executionError?: { message?: string } | null
		gasEffects?: { gasSummary?: Record<string, string | number> | null } | null
		objectChanges?: { nodes?: Array<{ address: string; idCreated?: boolean; idDeleted?: boolean; outputState?: { asMoveObject?: { contents?: { type?: { repr?: string } } } } | null }> }
		events?: { nodes?: Array<{ sequenceNumber?: number | string; contents?: { type?: { repr?: string }; json?: unknown }; sender?: { address?: string } | null }> }
	} | null
}

/** One GraphQL transaction in the JSON-RPC receipt shape. Pure; exported for tests. */
export function toChainTx(t: GqlTx): ChainTx {
	const e = t.effects ?? {}
	const ts = e.timestamp ? String(Date.parse(e.timestamp)) : undefined
	const g = e.gasEffects?.gasSummary ?? {}
	const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v))
	const events: QueriedEvent[] = (e.events?.nodes ?? []).map((n, i): QueriedEvent => ({
		type: n.contents?.type?.repr ?? '',
		parsedJson: n.contents?.json,
		id: { txDigest: t.digest, eventSeq: String(n.sequenceNumber ?? i) },
		timestampMs: ts,
	}))
	const objectChanges: RpcObjectChange[] = (e.objectChanges?.nodes ?? []).map((c) => ({
		type: c.idCreated ? 'created' : c.idDeleted ? 'deleted' : 'mutated',
		objectId: c.address,
		objectType: c.outputState?.asMoveObject?.contents?.type?.repr,
	}))
	return {
		digest: t.digest,
		timestampMs: ts,
		checkpoint: s(e.checkpoint?.sequenceNumber),
		effects: {
			status: { status: e.status === 'SUCCESS' ? 'success' : e.status ? 'failure' : undefined, error: e.executionError?.message },
			gasUsed: {
				computationCost: s(g.computationCost),
				storageCost: s(g.storageCost),
				storageRebate: s(g.storageRebate),
				nonRefundableStorageFee: s(g.nonRefundableStorageFee),
			},
		},
		events,
		objectChanges,
		transaction: { data: { sender: t.sender?.address, gasData: { budget: s(t.gasInput?.gasBudget) } } },
	}
}

/**
 * A transaction by digest. Throws when the indexer behind GraphQL has not reached it
 * yet — a just-executed transaction can take a few seconds to appear — so callers'
 * existing retry loops (`fetchTx`, `fetchReceipt`) wait it out.
 */
export async function getTransaction(post: PostJson, url: string, digest: string): Promise<ChainTx> {
	const d = await gql<{ transaction: GqlTx | null }>(post, url, `query($d: String!) { transaction(digest: $d) { ${TX_FIELDS} } }`, { d: digest })
	if (!d.transaction?.effects) throw new Error(`transaction ${digest} not found yet (graphql)`)
	return toChainTx(d.transaction)
}

/** The newest `limit` transactions SENT by `owner`, newest first, with their events. */
export async function ownerTransactions(post: PostJson, url: string, owner: string, limit = 50): Promise<{ data: ChainTx[]; hasNextPage: boolean }> {
	const d = await gql<{ transactions: { pageInfo: { hasPreviousPage: boolean }; nodes: GqlTx[] } }>(
		post,
		url,
		`query($a: SuiAddress!, $n: Int) { transactions(last: $n, filter: { sentAddress: $a }) { pageInfo { hasPreviousPage } nodes { ${TX_FIELDS} } } }`,
		{ a: owner, n: Math.min(limit, 50) },
	)
	return { data: d.transactions.nodes.map(toChainTx).reverse(), hasNextPage: d.transactions.pageInfo.hasPreviousPage }
}

// -----------------------------------------------------------------------------
// Finding our fills
// -----------------------------------------------------------------------------

/**
 * A fill cursor. The chain's event id, plus the fill's time — the indexer is queried by
 * time, and a cursor saved by an older version (no `timestampMs`) is resolved from its
 * transaction.
 */
export interface FillCursor extends EventCursor {
	timestampMs?: string
}

interface IndexerTrade {
	digest?: string
	timestamp?: number
	maker_balance_manager_id?: string
	taker_balance_manager_id?: string
}

/** Most trades one indexer call returns. A page this full means there may be more. */
export const INDEXER_PAGE = 1000
/** Pages walked back per query before giving up (20,000 of this manager's trades). */
const MAX_INDEXER_PAGES = 20

/**
 * A `QueryEvents` for `walkFills`, backed by the DeepBook indexer and verified on chain.
 *
 * Asks the indexer for this manager's trades in `poolKey` from the cursor's time to now,
 * then reads each named transaction from GraphQL and returns ITS `OrderFilled` events,
 * oldest first. `walkFills` then filters pool and manager exactly as it did over the
 * JSON-RPC event stream, and `FillLedger` drops anything already counted, so the
 * one-second overlap at the cursor costs nothing.
 */
export function indexerFillQuery(io: { get: GetJson; post: PostJson; indexerUrl: string; graphqlUrl: string; poolKey: string; managerId: string; now?: () => number }): QueryEvents {
	const now = io.now ?? Date.now
	return async ({ cursor }) => {
		const c = cursor as FillCursor | null
		let fromMs = Number(c?.timestampMs)
		if (!Number.isFinite(fromMs) && c?.txDigest) fromMs = Number((await getTransaction(io.post, io.graphqlUrl, c.txDigest)).timestampMs)
		if (!Number.isFinite(fromMs)) fromMs = now()
		// The indexer answers NEWEST first, so a full page is the newest INDEXER_PAGE trades of
		// the window. Walk the end of the window back to the oldest trade returned until a page
		// is not full; only then is everything from the cursor onward in hand.
		const base = `${io.indexerUrl.replace(/\/+$/, '')}/trades/${encodeURIComponent(io.poolKey)}?balance_manager_id=${io.managerId}`
		const trades: IndexerTrade[] = []
		let endS = Math.ceil(now() / 1000) + 1
		for (let page = 0; ; page++) {
			const url = `${base}&start_time=${Math.floor(fromMs / 1000)}&end_time=${endS}&limit=${INDEXER_PAGE}`
			const got = (await io.get(url)) as IndexerTrade[]
			if (!Array.isArray(got)) throw new Error(`deepbook indexer: unexpected response from ${base.split('?')[0]}`)
			trades.push(...got)
			if (got.length < INDEXER_PAGE) break
			if (page >= MAX_INDEXER_PAGES) throw new Error(`deepbook indexer: more than ${INDEXER_PAGE * MAX_INDEXER_PAGES} trades since the cursor; walk a shorter window`)
			// Seconds overlap at the boundary; the digest set below and FillLedger dedupe.
			endS = Math.ceil(Math.min(...got.map((t) => Number(t.timestamp))) / 1000)
		}
		const digests = [...new Set(trades.sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).map((t) => t.digest).filter((d): d is string => !!d))]
		const data: QueriedEvent[] = []
		for (const d of digests) data.push(...(await getTransaction(io.post, io.graphqlUrl, d)).events)
		const last = data.at(-1)
		const nextCursor: FillCursor | null = last?.id ? { ...last.id, timestampMs: last.timestampMs } : c
		return { data, nextCursor, hasNextPage: false } satisfies EventPage
	}
}

/** A cursor at a wall-clock instant: the fill walk starts there. */
export function cursorAtTime(timeMs: number): FillCursor {
	return { txDigest: '', eventSeq: '', timestampMs: String(Math.floor(timeMs)) }
}

export type { RpcEvent }

/**
 * Simulate unsigned transaction bytes — the gRPC replacement for `dryRunTransactionBlock`.
 * No key, no signature, nothing submitted. Returns the JSON-RPC-shaped effects the
 * measurement scripts print.
 */
export async function simulateEffects(
	client: { core: { simulateTransaction: (o: { transaction: Uint8Array; include?: Record<string, boolean> }) => Promise<unknown> } },
	bytes: Uint8Array,
): Promise<{ effects: { status: { status: string; error?: string }; gasUsed: { computationCost: string; storageCost: string; storageRebate: string; nonRefundableStorageFee?: string } } }> {
	const r = (await client.core.simulateTransaction({ transaction: bytes, include: { effects: true } })) as Record<string, unknown>
	const t = (r.Transaction ?? r.FailedTransaction ?? r.transaction ?? r) as { effects?: { status?: { success?: boolean; error?: unknown }; gasUsed?: Record<string, string> } }
	const st = t.effects?.status
	const g = t.effects?.gasUsed ?? {}
	return {
		effects: {
			status: { status: st?.success ? 'success' : 'failure', ...(st?.error ? { error: typeof st.error === 'string' ? st.error : JSON.stringify(st.error).slice(0, 300) } : {}) },
			gasUsed: { computationCost: String(g.computationCost ?? 0), storageCost: String(g.storageCost ?? 0), storageRebate: String(g.storageRebate ?? 0), nonRefundableStorageFee: g.nonRefundableStorageFee },
		},
	}
}

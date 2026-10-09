# SDK notes — where the shipped SDK differs from the docs

Read on 2026-09-13 against the exact pins in `package.json`: `@mysten/deepbook-v3` 2.4.1,
`@mysten/sui` 2.31.0, Node 22.22.3. Every row cites the declaration file in
`node_modules/` that settles it. "Docs" means
the DeepBook and Sui documentation pages, or the WaaP docs recipe
[Portfolio Rebalancer (Sui)](https://docs.waap.human.tech/recipes/sui-portfolio-rebalancer).

Type declarations ship as `.d.mts`, not `.d.ts` — a `dist/**/*.d.ts` glob finds nothing.

---

## A. `@mysten/sui` 2.31.0 — the client the rebalancer recipe uses is gone

**A1. `SuiClient` and `getFullnodeUrl` are no longer exported from `@mysten/sui/client`.**
`node_modules/@mysten/sui/dist/client/index.d.mts` exports `BaseClient`, `CoreClient`,
`ClientWithCoreApi`, `ClientCache`, `SuiClientTypes`, the error classes — and no
`SuiClient`, no `getFullnodeUrl`. The rebalancer page's
`import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'` does not compile on this pin.

Replacements, both of which satisfy DeepBook's `DeepBookCompatibleClient`:

| Want | Import |
|---|---|
| JSON-RPC (carries `dryRunTransactionBlock`) | `SuiJsonRpcClient`, `getJsonRpcFullnodeUrl` from `@mysten/sui/jsonRpc` — `dist/jsonRpc/index.d.mts` |
| gRPC (the non-deprecated path) | `SuiGrpcClient` from `@mysten/sui/grpc` — `dist/grpc/index.d.mts` |

`SuiJsonRpcClient` takes `{ url, network }` (`dist/jsonRpc/client.d.mts:40-60`);
`SuiGrpcClient` takes `{ baseUrl, network }` (`dist/grpc/client.d.mts:21-29`).
Every JSON-RPC symbol is marked `@deprecated` in its own JSDoc.

**A2. The Mysten public fullnode has retired JSON-RPC.** Runtime fact, not a typing fact.
`https://fullnode.mainnet.sui.io:443` answers every JSON-RPC method with:

```
JsonRpcError: Method not found. JSON-RPC on public fullnodes has been deprecated.
Please migrate to gRPC or GraphQL endpoints.  (code -32601)
```

So `getJsonRpcFullnodeUrl('mainnet')` returns a URL that no longer serves the API.
This recipe defaults `SUI_RPC` to **`https://sui-rpc.publicnode.com`**, verified working
on 2026-09-13. Backup: `https://rpc-mainnet.suiscan.xyz`. (`https://mainnet.sui.rpcpool.com` was listed here until it answered HTTP 403 to every call on 2026-09-25; it is no longer a default.)
Note `https://sui-mainnet-rpc.publicnode.com` (with `-mainnet-`) returns HTTP 404 — it is
not the same host.
The same `SuiGrpcClient({ baseUrl: 'https://fullnode.mainnet.sui.io:443' })` reads the
DEEP/SUI book fine, so gRPC is the forward path; this recipe stays on JSON-RPC only
because `dryRunTransactionBlock`, which the gas measurement uses, lives there.

**A3. `dryRunTransactionBlock` exists only on the JSON-RPC client.**
`dist/jsonRpc/client.d.mts:340`. The gRPC equivalent is
`SuiGrpcClient.simulateTransaction` (`dist/grpc/client.d.mts:116`); there is no
`dryRunTransactionBlock` anywhere under `dist/client/` or `dist/grpc/`.

**A4. One endpoint is not enough for an unattended run, and a dead one does not
announce itself as a network error.** Ticks 5 and 6 of the first funded run both failed
with `tick_failed {error: "fetch failed"}` from publicnode — undici's opaque wrapper,
carrying no status, no code and no cause detail. At the time five consecutive failures
exited the process, so a ~100 s blip at a 20 s poll would have ended a 24 h run.

`lib/waap.ts` now keeps a ring of endpoints — `SUI_RPC` first, then
`https://rpc-mainnet.suiscan.xyz` and `https://mainnet.sui.rpcpool.com` — and every RPC
read goes through `withRpc`: 3 attempts, 1 s / 3 s / 9 s, rotating to the next endpoint
on each failure that is the ENDPOINT's fault. `MAX_CONSECUTIVE_ERRORS` is 20.

Two things are easy to get wrong here.

*What counts as the endpoint's fault.* A transport failure does. So does JSON-RPC
`-32601`, even though the node answered — what it answered is that it does not serve
this API, which is a property of the endpoint (§A2 is exactly this case) and no amount
of retrying changes it. An invalid input object, an insufficient balance, an unknown
digest do NOT: the node answered correctly about the request, and asking two more nodes
the same bad question only burns two more nodes. `isEndpointFailure` draws that line;
anything below it is rethrown on attempt 1, unretried and unrotated. Verified
2026-09-15: `SUI_RPC=https://fullnode.mainnet.sui.io:443` logs one `rpc_retry`, then
`rpc_rotated` to suiscan, and the tick completes.

*What holds a stale client.* `DeepBookClient` takes `client` in its constructor and
keeps it, so it is deaf to a rotation. The `sui` export is now `let` — an ES module
export is a live binding, so anything reading `sui` at call time follows the rotation by
itself, but a DeepBookClient built before it does not. Hence `onRpcRotated`, which
`agent.ts` uses to rebuild through `makeDeepBookClient` (the one place the manager key
and the `balanceManagers` config, including the tradeCap slot this recipe leaves empty,
are set — so a rebuild cannot drift). The corollary for anything added later: never pass
a DeepBookClient across a function boundary, pass a getter. Every such signature in
`agent.ts` is `GetDb = () => DeepBookClient` for this reason.

*What a rotation does not reset.* The JSON-RPC transport calls `options.fetch ?? fetch`
(`dist/jsonRpc/http-transport.mjs`), and Node's global `fetch` keeps one connection pool
for the whole process, so a new client after a rotation still used the same sockets. In
live run 2b (28 Sep, 15:45–15:50Z) the long-lived process got `fetch failed` from both
endpoints for four ticks while a fresh Node process reached them. The log kept only
undici's opaque message, so the underlying cause is not known. `lib/waap.ts` now gives
the client its own undici `Agent` (connect 10 s, headers and body 30 s), replaces it on
every endpoint failure before the retry (`rpc_connections_recycled`), and logs the error's
`cause` chain on `rpc_retry` and `tick_failed`, so the next outage records its cause.
`lib/rpc-pool.test.ts` checks the recycle against a local server.

---

## B. `@mysten/deepbook-v3` 2.4.1

**B1. The constructor option is `network`, not `env`.**
`dist/client.d.mts` — `interface DeepBookClientOptions extends DeepBookOptions { client:
DeepBookCompatibleClient; network: SuiClientTypes.Network }`. The docs' `env` field does
not exist and is silently ignored if passed, leaving the client unconfigured.

**B2. `balanceManagers` is a map to `{ address, tradeCap?, depositCap?, withdrawCap? }`.**
`dist/types/index.d.mts:4-9`. The docs mention `address` plus `tradeCap`; the SDK also
carries `depositCap` and `withdrawCap`, so the custody split is finer than the docs
describe — deposit and withdrawal authority are separate capability objects from trade
authority (`mintTradeCap`, `mintDepositCap`, `mintWithdrawalCap`, and `revokeTradeCap`,
which "also revokes the associated DepositCap and WithdrawCap", in
`dist/transactions/balanceManager.d.mts`). This was an open question for the recipe's
design; the SDK's answer is that the caps are distinct and revocable.

**B3. `createAndShareBalanceManager` is on `client.balanceManager`, not
`client.deepbook.balanceManager`.** `dist/client.d.mts` declares the fields
`balanceManager: BalanceManagerContract` and `deepBook: DeepBookContract` directly on
`DeepBookClient`. The docs' `client.deepbook.balanceManager.createAndShareBalanceManager()`
is one level too deep, and `deepbook` (lowercase b) is not a field at all.
Signature: `createAndShareBalanceManager: () => (tx: Transaction) => void`
(`dist/transactions/balanceManager.d.mts`).

**B4. Order methods hang off `client.deepBook` — capital B.**
`dist/transactions/deepbook.d.mts`, reachable as `DeepBookClient.deepBook`:

| Method | Line | Shape |
|---|---|---|
| `placeLimitOrder(params)` | 21 | `(params: PlaceLimitOrderParams) => (tx: Transaction) => void` |
| `cancelOrder(poolKey, managerKey, orderId)` | 44 | closure, aborts on an unknown order id |
| `cancelAllOrders(poolKey, managerKey)` | 81 | closure |
| `withdrawSettledAmounts(poolKey, managerKey)` | 88 | closure |

The docs' closure-returning shape is right; the closure returns `void`, not `{}`.

**B5. Undocumented siblings worth knowing.** `cancelLiveOrder` / `cancelLiveOrders`
(`deepbook.d.mts:63, 74`) no-op on an order id that is already filled, cancelled or
swept, "unlike `cancelOrder`, this will not abort". A live maker requoting against a
stale view of its own book wants these rather than `cancelOrder`. Also
`withdrawSettledAmountsPermissionless` and `withdrawSettledAmountsManagerID`
(`deepbook.d.mts:95, 102`). This recipe now uses `cancelLiveOrder` — see §C4's go-live
note. It used `cancelOrder` while the resting set was synthetic and always current;
real ids can go stale between ticks, and that is exactly what `cancelLiveOrder` absorbs.

**B6. `PlaceLimitOrderParams` matches the docs** — `poolKey`, `balanceManagerKey`,
`clientOrderId`, `price`, `quantity`, `isBid`, optional `expiration`, `orderType`,
`selfMatchingOption`, `payWithDeep` (`dist/types/index.d.mts:57-68`). `price` and
`quantity` are `number | bigint` in human units; the SDK applies the coin scalars.

**B7. `getLevel2TicksFromMid` matches the docs**, including the snake_case fields:
`{ bid_prices, bid_quantities, ask_prices, ask_quantities }`, all `number[]`
(`dist/types/index.d.mts:294-299`, method at `dist/client.d.mts`). Live read of
`DEEP_SUI` on 2026-09-13 returned `bid_prices[0] = 0.02125`, `ask_prices[0] = 0.02127`.

**B8. `poolTradeParams` and `lockedBalance` match the docs.**
`PoolTradeParams { takerFee, makerFee, stakeRequired }` and
`LockedBalances { base, quote, deep }` (`dist/types/index.d.mts:240, 230`). Live
`poolTradeParams('DEEP_SUI')` = `{"takerFee":0,"makerFee":0,"stakeRequired":0}`, which
confirms the whitelisted-pool claim on chain rather than from the contract-information page.

**B9. `poolBookParams` is the on-chain source for tick / lot / min — the docs sweep
never names it.** `dist/client.d.mts`: `poolBookParams(poolKey): Promise<PoolBookParams>`
where `PoolBookParams { tickSize, lotSize, minSize }` (`dist/types/index.d.mts:245`).
Live `DEEP_SUI` = `{"tickSize":0.00001,"lotSize":1,"minSize":10}`, matching the
contract-information page. The agent reads it at startup instead of hardcoding.

**B10. The mainnet pool key and id agree with the docs.**
`dist/utils/constants.mjs:243-247` — `mainnetPools.DEEP_SUI.address =
0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22`, base `DEEP`, quote
`SUI`. (Testnet's `DEEP_SUI` is a different id, `0x48c95963…`, at line 206 — do not
cross them.) Mainnet package ids at `dist/utils/constants.mjs:11-19`, `DEEPBOOK_PACKAGE_ID
= 0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748`.

---

## C. Behaviour the docs do not mention

**C1. A BalanceManager id that is not on chain fails at `tx.build()`, not at send.**
Building a PTB resolves every input object through the RPC, so
`placeLimitOrder` / `cancelOrder` / `withdrawSettledAmounts` against a syntactically
valid but nonexistent manager throws:

```
Error: The following input objects are invalid: Object 0x1111…1111 does not exist
```

The same error comes back from `lockedBalance` and `checkManagerBalance`, which
`devInspect` and therefore also resolve the object. The agent catches both: it logs
`inventory_read_failed` and falls back to `DRY_RUN_BASE_INVENTORY` /
`DRY_RUN_QUOTE_INVENTORY`, then logs `tx_build_failed` and completes the tick instead of
crashing. Verified on 2026-09-13 with `DEEPBOOK_BALANCE_MANAGER_ID=0x1111…1111`: the tick logged `inventory_read_failed`, `quote_plan`, `tx_build_failed`, `tick_done`, and exited 0.

**C2. `queryEvents` on `<pkg>::balance_manager::BalanceManagerEvent` returns `[]` on
mainnet.** The docs' discovery route for finding an existing manager does not work from
the event type alone. What does work: `queryTransactionBlocks({ filter: { InputObject:
<poolId> }, options: { showEvents: true } })` and reading any `*balance_manager*` field
out of the parsed events. That is how the live manager used in the smoke runs was found.

**C3. The PTB needs no sender.** `tx.build({ client, onlyTransactionKind: true })`
produces the kind bytes `waap-cli send-tx --tx-format base64` takes, with no
`setSender` call — which is what lets the dry run work with no session at all.
190 bytes for the create-BalanceManager transaction, 990 bytes for a two-order requote
plus settle, 327 bytes for a settle-only tick.

**C4. `cancelOrder` takes a u128 order id, and only the chain can issue one.**
`dist/transactions/deepbook.d.mts:44` types `orderId` as `string`, which hides the
constraint: the string is BCS-encoded as a `u128`, so anything that is not a decimal or
`0x`-hex integer throws **while the transaction is being built**, not at send:

```
TypeError: Cannot convert t1-bid-0 to a BigInt
```

This bit the first 30-tick proof run. The agent's dry run has no on-chain ids — nothing
was submitted, so nothing was issued — and its `state.resting` entries carry placeholder
ids of its own making. As soon as the mid moved far enough for the planner to requote, the
cancel branch handed a placeholder to `cancelOrder` and every such tick threw, five in a
row, and the run self-terminated at tick 12 of 30.

The fix, in `agent.ts` only: tracked orders carry `simulated: true` when the id is the
agent's own, and the PTB builder adds a `cancelOrder` call only for an id that is both
non-simulated and shaped like a u128 — everything else is logged as
`cancel_skipped_simulated` and counted as `cancelsSkipped` in `quote_plan` and `tx_built`.
The planner is untouched: `plan.cancels` still lists what *should* be cancelled, so the
requote-tolerance logic behaves identically. Verified both ways on 2026-09-13 — a seeded
pair of simulated orders 5 % off mid produced `cancelsSkipped: 2` and a clean 990-byte
`tx_built`; a seeded real u128 id produced `cancelsBuilt: 1` and a 1240-byte `tx_built`
with the cancel call in it.

**Go-live consequence — closed 2026-09-14.** The live path used to have the same gap.
It no longer does: `agent.ts` now refetches its own transaction after
`signAndSendTx` returns a digest and writes the chain's u128 ids into `state.resting`
with `simulated: false`. The placeholder branch is the dry-run branch only. See §D for
the event shapes that made it possible.

A second change came with it. The cancel call is now `cancelLiveOrder`, not
`cancelOrder` (§B5). With real ids in state, an order can fill between the tick that
read the book and the tick that cancels it; `cancelOrder` aborts the whole PTB on an id
the manager no longer holds, and `cancelLiveOrder` no-ops.

**C5. `lockedBalance` is not "funds locked in resting orders" — it also carries
unswept fill proceeds.** The single most expensive thing to assume wrongly in this
recipe, and the docs describe it only as `LockedBalances { base, quote, deep }` (§B8).
Measured on mainnet against manager `0xdceb4ba0…dd2b5` on 2026-09-15, either side of the
live bid filling:

| | `lockedBalance` | `accountOpenOrders` | `account().settled_balances` |
|---|---|---|---|
| bid for 20 DEEP @ 0.02087 resting | `{base: 0, quote: 0.4174}` | 1 order | `{base: 0, quote: 0}` |
| same bid filled | `{base: 20, quote: 0}` | `[]` | `{base: 20, quote: 0}` |

So `locked_balance` = what open orders have locked **plus** `settled_balances`. The two
halves behave completely differently inside a PTB:

* order locks are returned by a `cancel` **inside the same transaction**, so they can
  back a `placeLimitOrder` that comes after the cancel in that PTB;
* a settled balance is swept by `withdrawSettledAmounts`, which this agent puts **last**
  in the tick's PTB — after the places. An order sized against it would be unbacked at
  the moment it is placed. It becomes spendable on the *next* tick, once swept.

`lib/quotes.ts` therefore treats the chain figure as a **ceiling, not a quantity**:
`min(ownOrderLock(resting), lockedBalance[coin])`, where `ownOrderLock` derives the lock
from the resting set (a bid for `q` at `p` locks `q × p` quote; an ask for `q` locks `q`
base). The ceiling is not decoration — it is what stops a stale `state.resting` entry,
for an order that has actually filled, from conjuring quote that is no longer locked.

**C6. Inventory churn: a resting order's own lock must never make its side look empty.**
The defect this recipe shipped with, visible in ticks 2-4 of `logs/live-5tick.jsonl`.
Tick 2 placed a 20 DEEP bid worth 0.417 of the 0.45 SUI deposit. Tick 3 read the
available quote balance — 0.033 SUI, the rest now locked in that very bid — decided
`quote_below_size`, and cancelled a perfectly good order. Tick 4 saw the quote free and
re-placed it at a price one tick away. Two transactions, two gas payments, no change to
the quote, and the cycle repeats forever.

The fix has two halves and the first is the load-bearing one:

1. **Reconcile the resting set before consulting inventory.** A resting order within
   `REQUOTE_TOLERANCE_BPS` keeps its side quoted, full stop; the side is not sized
   against inventory at all, and only duplicates on it are cancelled. A side that is
   already quoted needs no funding.
2. **When the mid HAS moved beyond tolerance,** the order is cancelled and a new one
   placed in one PTB, and that is correct: the cancel unlocks and the place that follows
   it draws on the unlocked funds within the same transaction. So the planner may plan a
   place on a side whose *available* balance is short by exactly the amount being
   cancelled. This is only sound because a keep and a place are mutually exclusive per
   side — if anything is kept, nothing is placed, and if anything is placed, every
   resting order on that side is in `cancels`. Do not relax that invariant.

Verified live, dry run, against the funded manager on 2026-09-15: with the bid resting
and the mid inside tolerance, `inventory` logged `quoteLocked 0.4174` and `quote_plan`
logged `cancels: [], place: []`; when the mid moved ~19 bps away, the same tick planned
`cancels: [<id>]` plus a bid at the new target and built a 935-byte PTB, with only
0.0326 SUI available against a 0.4182 SUI order.

One more reason the cancel is safe: the agent uses `cancelLiveOrder`, not `cancelOrder`
(§B5). A stale `state.resting` entry for an order that filled between ticks produces a
cancel that no-ops rather than aborting the PTB — which is exactly what happened on the
smoke run after the live bid filled.

---

## D. DeepBook events, and the scaling that makes them readable

Read off mainnet on 2026-09-14 through `https://sui-rpc.publicnode.com`. Every claim
here cites either a declaration file or the transaction digest it came from; the fetched
JSON is saved verbatim under `lib/fixtures/` and `lib/events.test.ts` asserts against it.

**D1. Event structs carry the ORIGINAL package id, not `DEEPBOOK_PACKAGE_ID`.** This is
the trap. The SDK's `mainnetPackageIds.DEEPBOOK_PACKAGE_ID` is
`0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748`
(`dist/utils/constants.mjs:11-19`), but every order event on chain is typed against
`0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809` — the package id
DeepBook v3 was first published under. Move keeps a struct's type at its defining
package, so an upgrade does not renumber it. Building a filter string out of the SDK
constant therefore matches nothing. `lib/events.ts` matches on the `::module::Struct`
suffix instead, which also survives the next upgrade.

**D2. The three structs, and the two modules they live in.**

| Event | Full type suffix | Seen in digest |
|---|---|---|
| Order placed | `::order_info::OrderPlaced` | `EiWShmMjLDeiaveYodNP2ZLT3MCYQfUBZTMcYFQXjDcD` |
| Order cancelled | `::order::OrderCanceled` | `2DEcMC3NrSbC6vkyjjGcxp6i2qc2bPXLLWDmt8Phq7Rf` |
| Order filled | `::order_info::OrderFilled` | `6eQtWxBR4dpyyhewZxRss7XZe38S5ryUgJyKjERU8sdh` |

Note the modules differ — `OrderPlaced` and `OrderFilled` are in `order_info`,
`OrderCanceled` is in `order`. Also on chain and not used here:
`::order_info::OrderExpired`, `::order::OrderModified`, and an
`::order_info::OrderInfo` emitted alongside every `OrderPlaced` carrying the same order
under different field names. `queryEvents` on `::order_info::OrderCanceled` returns `[]`,
which is what sends you looking in the wrong module.

**D3. Field names.** One American spelling (`Canceled`), one field that is not called
`quantity`, and one side flag that is the taker's, not the maker's.

| Event | Fields |
|---|---|
| `OrderPlaced` | `balance_manager_id`, `client_order_id`, `expire_timestamp`, `is_bid`, `order_id`, **`placed_quantity`**, `pool_id`, `price`, `timestamp`, `trader` |
| `OrderCanceled` | `balance_manager_id`, **`base_asset_quantity_canceled`**, `client_order_id`, `is_bid`, `order_id`, `original_quantity`, `pool_id`, `price`, `timestamp`, `trader` |
| `OrderFilled` | `base_quantity`, `quote_quantity`, `price`, `maker_order_id`, `maker_balance_manager_id`, `maker_client_order_id`, `maker_fee`, `maker_fee_is_deep`, `taker_order_id`, `taker_balance_manager_id`, `taker_client_order_id`, `taker_fee`, `taker_fee_is_deep`, **`taker_is_bid`**, `pool_id`, `timestamp` |

`OrderFilled` reports `taker_is_bid`. This agent is the maker, so **its** side is the
opposite: `isBid = !taker_is_bid`. Getting this backwards would report every sale as a
purchase in the 24 h fills count.

**D4. The scaling formula.** On-chain integers are scaled three ways, and the price
scaling is a cross-scalar, not a single divisor.

From `dist/utils/conversion.mjs`:

```js
convertQuantity(value, scalar)                       // :6   value * scalar
convertPrice(value, floatScalar, quoteScalar, baseScalar)
                                                     // :13  value * floatScalar * quoteScalar / baseScalar
```

with `FLOAT_SCALAR = 1e9` (`dist/utils/config.mjs:6`) and the per-coin scalars in
`dist/utils/constants.mjs`: `DEEP` 1e6 (`:81`), `SUI` 1e9 (`:89`), `USDC` 1e6 (`:97`),
`NS` 1e6 (`:162`). So, inverting:

```
human price    = onChainPrice    /  (FLOAT_SCALAR * quoteScalar / baseScalar)
human base qty = onChainBaseQty  /  baseScalar
human quote qty= onChainQuoteQty /  quoteScalar
```

For DEEP/SUI the price divisor is `1e9 * 1e9 / 1e6 = 1e12`. Checked against the real
fill in digest `6eQtWxBR4dpyyhewZxRss7XZe38S5ryUgJyKjERU8sdh`, where
BalanceManager `0x344c2734…d27d` was the resting maker:

| Field | On chain | Human |
|---|---|---|
| `price` | `20910000000` | 0.02091 SUI per DEEP |
| `base_quantity` | `540000000` | 540 DEEP |
| `quote_quantity` | `11291400000` | 11.2914 SUI |

and 540 × 0.02091 = 11.2914, which is the arithmetic check `lib/events.test.ts` runs.
`lib/waap.ts` reads the scalars out of the SDK constants rather than hardcoding them, so
pointing `POOL_KEY` at another pool carries the right divisors with it.

**D5. The created BalanceManager comes from `objectChanges`, not from an event.**
`queryEvents` on `balance_manager::BalanceManagerEvent` returns `[]` on mainnet (§C2), so
the id is read from the transaction's object changes: the `created` entry whose
`objectType` ends in `::balance_manager::BalanceManager`. The suffix must be exact — the
same transaction can create a `::balance_manager::TradeCap`. Verified against digest
`8xMfiqw7HR9drnvVc8dKkN3jgW43PLVCJWeksLRip6GC`, which creates both, and whose
BalanceManager is `0xb25bb9bd…0514`.

**D6. Deposit, withdraw and cancel-all signatures.** For `deposit.ts` and `stop.ts`,
from `dist/transactions/balanceManager.d.mts` and `dist/transactions/deepbook.d.mts`:

| Call | Declaration | Signature |
|---|---|---|
| `depositIntoManager` | `balanceManager.d.mts:38` | `(managerKey, coinKey, amountToDeposit: number) => (tx) => void` |
| `withdrawAllFromManager` | `balanceManager.d.mts:55` | `(managerKey, coinKey, recipient: string) => (tx) => void` |
| `cancelAllOrders` | `deepbook.d.mts:81` | `(poolKey, balanceManagerKey) => (tx) => void` |

Amounts are human units; the SDK applies the coin scalar. `withdrawAllFromManager` takes
an explicit recipient — there is no "back to the sender" default.

**D7. A DEEP deposit needs DEEP coin objects in the wallet; a SUI deposit does not.**
Runtime fact, found building the dry run. `depositIntoManager('MAKER', 'SUI', 25)`
serialises to 171 bytes because SUI is split off the gas coin. The same call for DEEP
resolves real coin objects through the RPC at `tx.build()` time and fails there if the
wallet is short:

```
Error: Insufficient balance of 0xdeeb…c270::deep::DEEP for owner 0x0000…0000.
Required: 1000000000, Available: 287874965
```

The two-coin PTB built fine once the sender held enough DEEP — 4202 bytes, most of it
the merge of many small DEEP coin objects. Worth knowing for the SUI-only bootstrap:
the first `npm run deposit` moves SUI only, and there is no DEEP deposit to make until
a bid has filled.

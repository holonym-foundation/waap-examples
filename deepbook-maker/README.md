# DeepBook maker — a WaaP agent that quotes both sides of DEEP/SUI

An agent that makes a market on [DeepBook](https://deepbook.tech)'s DEEP/SUI pool on Sui mainnet, without ever holding a key. Every tick it reads the book, decides what to cancel and what to place, builds **one unsigned transaction**, and hands the bytes to [`waap-cli`](https://www.npmjs.com/package/@human.tech/waap-cli). In WaaP Standard mode the signing key is held inside WaaP's enclave; this process has no key and cannot sign on its own.

Walkthrough and the results of a mainnet run: [DeepBook Market Maker recipe](https://docs.waap.human.tech/recipes/deepbook-maker).

> **Not a strategy.** The quoting rule is a fixed spread around mid at a fixed size. On mainnet, at 20 DEEP a side and 20 bps, it lost money: spread did not cover gas, and the price moved further than the spread between fills. `planQuotes()` in `lib/quotes.ts` is the function to replace.

Dry run is the default. Nothing is signed unless `AGENT_DRY_RUN` is exactly `0`.

## Install and dry run

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/deepbook-maker
cd deepbook-maker
npm ci
cp .env.example .env          # nothing secret in it
npm test                      # unit tests, no network
./node_modules/.bin/tsx agent.ts
```

A dry run reads the live book and builds real transactions, then logs `dry_run_skip` instead of signing. Without a waap-cli session it logs `dry_run_no_session` and uses the zero address for logging only.

## Going live

1. **Log in and fund.** `waap-cli login`, then `waap-cli whoami --json` for the Sui address. Fund it with SUI for inventory and gas.
2. **Set your daily spend limit.** `waap-cli policy set --daily-spend-limit <usd>`. This is the point at which the day's total starts requiring your approval: a threshold, not a cap. Use a separate account, funded with only what you want on the book, if you need a hard boundary.
3. **Create the BalanceManager.** `AGENT_DRY_RUN=0 MAX_TICKS=1 ./node_modules/.bin/tsx agent.ts`. The first live tick creates it and writes its id to `state.json`, and quotes nothing.
4. **Deposit.** `AGENT_DRY_RUN=0 DEPOSIT_SUI=0.45 npm run deposit`. SUI only is fine: the agent quotes bids until one fills, then both sides.
5. **Run the loop, directly.** `AGENT_DRY_RUN=0 ./node_modules/.bin/tsx agent.ts`, optionally with `MAX_TICKS` for a bounded run. **Do not launch a long run through `npm run`**: on Linux, npm does not pass SIGTERM on to the agent, so stopping npm can leave the agent quoting.
6. **Stop, in this order.**
   1. SIGTERM the agent (Ctrl-C, or `systemctl --user stop <unit>`), and wait for its `shutdown` line.
   2. Check no agent process is left (the agent removes `agent.pid` on a clean exit).
   3. `AGENT_DRY_RUN=0 npm run stop`: one transaction that cancels every order, then withdraws both coins to the wallet.
   4. Confirm on chain that the manager has no open orders and holds nothing.

   An exited process has not cleaned up the book; step 3 does. `stop.ts` cancels by manager, not from `state.json`, so it works from any machine logged in to the same account.

`./stop-check.sh` rehearses steps 5–6 as a dry run. It uses a replaced environment, an empty `.env`, a temporary `HOME` and a stand-in `waap-cli` that refuses to sign. It fails if anything reached a signer.

## Scripts

| Command | What |
|---|---|
| `./node_modules/.bin/tsx agent.ts` | The loop |
| `npm run deposit` | Wallet → BalanceManager (`DEPOSIT_SUI`, `DEPOSIT_DEEP`) |
| `npm run stop` | Cancel every order, then empty the manager |
| `npm run refuse-probe` | One deliberate deposit above your daily limit, to see the policy engine answer. It must be smaller than the wallet balance, or it is rejected before the policy engine sees it |
| `npm test` / `npm run typecheck` | Unit tests (no network) / `tsc --noEmit` |
| `./stop-check.sh` | Dry rehearsal of the launch-and-stop path |
| `npm run receipts` | Fetch every receipt a log submitted, and total the gas by kind |
| `npm run fills` | Walk the chain's `OrderFilled` events for this manager, and print spread against gas |
| `npm run grade:smoke` | Grade a bounded live run from its log and the chain: `PASS`, `PASS_WITH_DISCLOSED_EXCEPTION` or `FAIL` (rules in `lib/smoke.ts`) |
| `npm run measure`, `npm run measure:shapes`, `npm run measure:requote` | RPC gas simulation of the transaction shapes; replay of the requote rule over a real price series |

Every variable, with its default and what it does, is in `.env.example`.

## Known issues

- **Occasional `InsufficientGas` on chain.** In Standard mode, `waap-cli send-tx` takes the transaction kind, and WaaP's preparation step sets the gas budget just above the estimated cost. There is no option to set it yourself. When the book moves between preparation and execution, a requote can fail on chain. In a 6 h 55 m mainnet run this was 4 of 134 requotes, at about 0.00018 SUI each; the next tick requoted successfully each time.
- **RPC endpoints.** Mysten's public fullnode no longer serves the JSON-RPC methods the SDK uses. The default is publicnode, with suiscan as fallback. Check any endpoint you add before a long run.
- **Inventory drift.** A fixed clip size can leave neither side backable after a run of adverse fills. The agent then quotes nothing and keeps ticking, and says why in `skippedSides`.

## Events

One JSON object per line, to stdout and to `AGENT_LOG_FILE`.

| Event | When | Carries |
|---|---|---|
| `dry_run_no_session` | Start, in dry run with no `WAAP_AGENT_ADDRESS` | A note that the zero address is being used for logging only |
| `agent_start` | Start | Network, RPC, pool key and id, spread, size, floors, tolerance, poll interval, max ticks, dry-run flag, BalanceManager id, owner |
| `book_read` | Every tick | `bestBid`, `bestAsk`, `mid` |
| `book_params` | First quoting tick | `tickSize`, `lotSize`, `minSize`, and whether they came from chain or the fallback |
| `balance_manager_missing` | No manager id in state or env | The state file path; the tick quotes nothing. From `deposit`, `stop` or `refuse-probe` it is fatal — those need an existing manager |
| `balance_manager_created` | Live, after a `create_balance_manager` send | The digest and the created manager id, already written to `state.json` |
| `balance_manager_not_found` | Live, the create transaction landed but no `::balance_manager::BalanceManager` was created | The digest; nothing is persisted |
| `inventory` | Every quoting tick | Free base and quote in the manager, locked balances, and whether the read came from chain or the dry-run fallback |
| `inventory_read_failed` | Dry run, manager unreadable | The RPC error; the tick continues on the fallback figures |
| `quote_plan` | Every quoting tick | `cancels`, `cancelsSkipped`, `place`, and `skippedSides` — one reason per unquoted side: `base_below_size` (no DEEP to sell, the SUI-only case), `quote_below_size`, `base_below_floor`, `quote_below_floor`, `size_below_min`, `no_price` — plus the mid and spread they came from |
| `cancel_skipped_simulated` | A cancel the planner asked for that has no on-chain id | `orderId` and the reason (`simulated_order` or `not_a_u128_order_id`). One line per order. Expected on every dry run, where nothing was ever submitted and the ids are the agent's own. On a **live** run it should not appear: ids there come from `OrderPlaced` events. If it does, look for an `orders_unconfirmed` line above it |
| `tx_built` | Every transaction built | `kind` (`create_balance_manager` or `requote`), `bytesLen`, `b64Len`, and the order counts — `cancels` (planned), `cancelsBuilt` (actual move calls), `cancelsSkipped`, `places` |
| `tx_build_failed` | The SDK could not resolve an input object | The error; the tick completes without quoting instead of crashing |
| `dry_run_skip` | Dry run, at the point of signing | `kind`, the length of the base64 bytes, and the running `send-tx` call counter |
| `tx_submitted` | Live only, once waap-cli returns a digest | `kind` (`requote`, `create_balance_manager`, `deposit`, `stop`) and the digest. Not emitted in a dry run |
| `tx_gas` | Live, after the receipt for a submitted digest is read | `status`, `computationMist`, `storageMist`, `rebateMist`, `netSui`, `grossSui` and the running `runNetSui`. Written separately from `tx_submitted` so a submission whose receipt could not be read is a **visible gap**, not a silent zero |
| `tx_gas_missing` / `tx_gas_failed` | The receipt had no effects, or the read threw | The digest. Its cost is unknown, not zero — `npm run receipts` backfills it |
| `fill_cursor` | Start | Where the fill walk begins: `state` (resuming, the gap is backfilled) or `anchor` (a fresh `TimeRange` anchor at the process start) |
| `fill_scan` | Every quoting tick | `pages`, `scanned`, `newFills`, `totalFills`, `truncated` and the cursor. `truncated: true` means the walk has not caught up and the next tick continues it |
| `fill_scan_failed` | A fill scan threw | The error. **The tick is not failed by it** — collection is measurement and must not be able to fail a tick that quoted correctly |
| `tick_no_submit` | `SKIP_EMPTY_TICK=1` and there was no cancel, no place and nothing settled | The settled balances and the skip reason. No transaction is sent |
| `settle_needed` | `SKIP_EMPTY_TICK=1` but a settled balance is waiting, or the settled read failed | The settled balances. The tick submits the sweep rather than skipping |
| `settled_read_failed` | `account()` could not be read | The error. The tick submits rather than skips: not knowing is never a reason to skip a sweep |
| `fill` | Live, one line per `OrderFilled` where this manager was the resting maker | `orderId`, **`isBid` and `side`** (both spellings; `isBid` is the one to count on), `price`, `quantity`, `quoteQuantity`, the taker's manager, the event `key` (`txDigest:eventSeq`) and `source` (`event_scan` or `own_tx`). The side is the maker's, not the taker's |
| `orders_confirmed` | Live, after a `requote` send | The real u128 ids DeepBook issued with their side, price and quantity; the ids an `OrderCanceled` event retired; the fill count; and the new resting total |
| `orders_unconfirmed` | Live, the transaction could not be read back | The digest; the resting set is left as planned and the next tick says so |
| `tx_fetch_failed` | Refetching a submitted transaction failed every retry | The digest and the RPC error |
| `deposit_start` / `deposit_done` | `npm run deposit` | Which coins and how much, the manager id, and the digest |
| `nothing_to_deposit` | `npm run deposit` with no positive amount | Which variables to set. Exits 1 |
| `stop_start` / `stop_done` | `npm run stop` | The manager id, the withdraw recipient, both coins, and the digest |
| `recipient_is_zero_address` | `npm run stop` in a dry run with no session | A note that the withdraw was built against the zero address for byte-length purposes only |
| `refuse_probe_start` | `npm run refuse-probe` | The probe amount and the manager it targets |
| `policy_probe` | `npm run refuse-probe`, after the send | The **whole waap-cli response, verbatim** — stdout and stderr, kept even when the CLI exits nonzero — plus `exitCode`, the amount, the digest if there was one, the error if the call threw, and `outcome` / `matched` / `isPolicyEvidence` from `lib/policy.ts`. Read `outcome`, not the exit code: a refusal is `policy_ask` or `policy_reject`, and `insufficient_funds` means the chain said no before the policy did. Null response in a dry run: waap-cli was never invoked |
| `policy_probe_inconclusive` | Live probe whose outcome is not policy evidence | The outcome. Read `policy_probe.response` by hand |
| `tick_done` | End of every tick | Whether the tick quoted, and how many orders are believed resting |
| `next_check` | Between ticks | `inMs` |
| `tick_failed` | A tick threw | The error and the consecutive-failure count. `MAX_CONSECUTIVE_ERRORS` in a row (default 20) exits 1 |
| `too_many_consecutive_errors` | The failure limit was reached | `sendTxCalls` and `sendTxRefused` for this process. The process exits 1 without a `shutdown` line |
| `resting_reconciled` | A tick found the chain's open orders differ from state | Orders dropped (filled or cancelled), adopted (on chain, not in state) and resized (partly filled) |
| `open_orders_read_failed` | The open-orders read threw | The error. The tick skips the reconcile rather than wiping the resting set |
| `fill_gap` / `fill_cursor_failed` | Start with a saved fill cursor / the anchor read failed | The live fill walk starts at the present; `npm run fills` covers the gap |
| `rpc_retry` / `rpc_rotated` / `deepbook_client_rebuilt` | An RPC read failed | The host, the attempt, whether it counts as an endpoint failure (transport, 401/403/429/5xx, -32601), and the endpoint rotated to |
| `rpc_rotation_listener_failed` | A rotation hook threw | The error |
| `receipt_fetch_failed` | A receipt could not be read after retries | The digest. Its cost is unknown, not zero |
| `shutdown_signal` | SIGINT or SIGTERM received | The signal; a `shutdown` line follows |
| `bad_probe_amount` | `npm run refuse-probe` with an invalid `PROBE_SUI` | The value. Exits 1 |
| `shutdown` | `MAX_TICKS` reached or a signal | Reason, tick count, dry-run flag, the total `send-tx` call count (`0` for any dry run), plus `startedAt`, **`elapsedMs` / `elapsedHours`** (the run length to report — `ticks × POLL_MS` always undershoots), the fill totals and the gas totals for **this process**. A deposit, probe or stop runs as its own process and appends to the same file, so compare a loop's `sendTxCalls` against that loop's own `tx_submitted` lines |
| `fatal` | Unhandled error in `main` | The error; exit 1 |

---


## Layout

| Path | What |
|---|---|
| `agent.ts` | The loop: read the book, plan, build, send, reconcile against the chain |
| `deposit.ts`, `stop.ts`, `refuse-probe.ts` | One-shot scripts, each its own process |
| `lib/waap.ts` | The waap-cli signing spine, RPC rotation, the logger, the clients, the transaction serialiser |
| `lib/quotes.ts` | `planQuotes()` and the reconcile, pure: no network, no clock |
| `lib/events.ts`, `lib/fills.ts` | Parsers over DeepBook events; run-window fill collection |
| `lib/receipts.ts`, `lib/spread.ts` | Gas from receipts; realized spread, FIFO |
| `lib/policy.ts` | Classifies waap-cli's answer to the policy probe |
| `lib/smoke.ts`, `grade-smoke.ts` | The bounded-run grade |
| `lib/*.test.ts`, `lib/fixtures/` | Tests, several fed real mainnet transactions |
| `SDK-NOTES.md` | Where the pinned SDK differs from the docs, with the declaration file that settles each |

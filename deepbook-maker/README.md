# DeepBook maker: a WaaP agent that makes a bounded market on DEEP/SUI

An agent that quotes both sides of [DeepBook](https://deepbook.tech)'s DEEP/SUI pool on Sui mainnet without holding a key. The account runs in WaaP Standard mode, where the signing key is held inside WaaP's enclave. Every tick the agent:

1. reads the book;
2. reconciles its orders, fills, pending sends and budgets against the chain;
3. decides what to quote;
4. builds **one unsigned transaction**, then hands the bytes to [`waap-cli`](https://www.npmjs.com/package/@human.tech/waap-cli).

Walkthrough: [DeepBook Market Maker recipe](https://docs.waap.human.tech/recipes/deepbook-maker).

Dry run is the default. Nothing is signed unless `AGENT_DRY_RUN` is exactly `0`.

The built-in strategy has not demonstrated profitability; treat it as a starting point for your own. Measured mainnet results, with every digest and a ledger you can re-derive from the chain, are in [`VALIDATION.md`](./VALIDATION.md).

## What the built-in maker does

The maker quotes passive, post-only orders around the mid price. It keeps inventory inside a band, sizes each order to what it can back, and quotes only when the spread covers the **estimated** cost of a quoting cycle under the cost assumptions you configure. The code is `lib/strategy.ts`, a pure function with its tests beside it.

- **Inventory band.** The base share of the manager's value, `f = base × mid / (base × mid + quote)`, stays between `BAND_LOW` and `BAND_HIGH` (default 20 to 80 %, target 50 %). Each order is sized so that `f` stays inside the band **if that order fills completely**. The opposite side is not assumed to fill. At the upper bound the maker stops bidding; at the lower bound it stops offering. Inside the band the quotes are skewed by up to `SKEW_MAX_BPS`, toward the side that brings `f` back to target.
- **Backed sizes.** Each side is sized to the smallest of:
  - `ORDER_SIZE`;
  - the band cap;
  - what the transaction can actually spend. That is free balance plus what cancelling our own orders on that side releases.

  Proceeds settled from a fill count as owned, but they cannot back an order until they are swept. A partly filled order, such as 17 DEEP left of 20, is kept rather than replaced. Below the pool minimum on both sides, the maker says so (`inventory_limited`) and says what deposit would fix it.
- **Cost gate.** Gas on Sui is charged per transaction, not per DEEP, so a small order has to earn a wide spread. The maker widens its spread to what covers the estimated cost of one **cycle** (a bid fill plus an ask fill of the same size) at that size. The estimate is the sum of the transaction shapes the cycle sends, each costed from a fixed table of receipts from earlier mainnet runs (`lib/costs.ts`), at the quantile and replacement count you configure (`COST_QUANTILE`, `COST_REPLACEMENTS_PER_CYCLE`):
  - two refills;
  - `COST_REPLACEMENTS_PER_CYCLE` replacements;
  - failed sends;
  - amortised setup and cleanup.

  If the spread needed is above `MAX_SPREAD_BPS`, or more than `TOUCH_MULTIPLE` × the current touch spread (with our own orders excluded), the maker pauses; it never widens out of reach. A pause for cost cancels everything. A pause caused only by the liquidity rule places nothing new but keeps resting orders that still pass the keep rules (band cap, expiry, price tolerance); a held order can still be filled. Once paused on that rule, the maker resumes placing only after `LIQUIDITY_MIN_PAUSE_MIN` (10) and when its spread is inside the rule by `LIQUIDITY_RESUME_MARGIN` (25 %). In the 28 September live run, without this, 12 of 15 sends were pause/resume flips; the same run replayed offline with it (`lib/fixtures/run-2b-touch-series.json`) sends 8 times, none a flip. This change has not yet run live. The gate is re-checked on the final rounded prices. Passing it means the spread covers the *estimated* cost of one cycle if both legs fill. Actual gas can be higher than the estimate, and the gate does not predict fills; it is not a profit forecast.
- **Discretionary replacements.** A drifted order is replaced only after it has passed `REQUOTE_TOLERANCE_BPS` **and** lived `MIN_DWELL_SEC`. Risk overrides the dwell and cancels at once. Risk means a band breach, a size above the cap, an order near expiry, a pause or a halt.
- **Finite orders.** Orders are `POST_ONLY` (a crossing quote aborts instead of taking), cancel a self-match, and expire after `ORDER_TTL_MIN`. Expiry limits how long a crashed process's orders can trade. It does not withdraw anything; cleanup does that.
- **Limits.** The loop halts, then cleans up, when it reaches any of these:
  - the gas cap (`GAS_CAP_SUI`);
  - inventory drawdown (`MAX_DRAWDOWN_SUI`), which measures manager value at mid against the run's start and is not total P&L;
  - run length (`MAX_RUN_MIN`);
  - `MAX_TICKS`;
  - repeated failures;
  - an unexpected taker fill.

  Turnover over `TURNOVER_WINDOW_HOURS` pauses new orders. It never liquidates, swaps or buys inventory.

### A worked example: why size matters more than spread

Figures are from `lib/costs.ts`. Net gas per shape comes from receipts of three earlier mainnet runs of this recipe. They are historical, not today's prices. The loop counts every receipt against its gas cap, but it does not update these figures.

| Order size | Cycle cost, median shapes, 1 replacement | Spread needed | Cycle cost, p90 shapes, 3 replacements (default) | Spread needed |
|---|---|---|---|---|
| 10 DEEP | 0.0049 SUI | 255 bps | 0.0103 SUI | 539 bps |
| 20 DEEP | 0.0049 SUI | 128 bps | 0.0103 SUI | 269 bps |
| 50 DEEP | 0.0049 SUI | 51 bps | 0.0103 SUI | 108 bps |
| 100 DEEP | 0.0049 SUI | 26 bps | 0.0103 SUI | 54 bps |

At mid 0.0191. The spread needed is 1e4 × cycle cost ÷ (size × mid); maker fees are 0 on DEEP/SUI.

The DEEP/SUI touch spread averaged 47 bps over the 27 Sep smoke and 91 bps over the 25 Sep run, ranging from 5 to 512 bps. At 20 DEEP the default gate asks for about 270 bps, so the maker quotes only when the book is wide. At 50 to 100 DEEP it can sit near the touch.

The band decides how much capital that size needs. To keep a full `q`-DEEP fill inside a 20 to 80 % band from a 50 % start, the manager needs about `3.3 × q × mid` SUI of value. That is 1.3 SUI for 20 DEEP, 3.2 SUI for 50 DEEP and 6.4 SUI for 100 DEEP, before a gas and cleanup reserve.

If only one side fills and the price then moves against the position, the band stops further same-side orders. The drawdown limit then ends the run: cancel → settle → withdraw, with the remaining inventory returned to the wallet and reported at mid. It is not sold.

`lib/strategy.test.ts` covers these cases with scripted fills (fills are never inferred from prices):

- a flat book;
- a trending book;
- a jumping book;
- a bid-only fill followed by a falling price;
- a SUI-only start;
- partial fills;
- fee changes;
- a stale book.

## Install and dry run

```bash
npm i -g @human.tech/waap-cli@2.2.0    # the version this recipe was tested with
npx gitpick holonym-foundation/waap-examples/tree/main/deepbook-maker
cd deepbook-maker
npm ci
cp .env.example .env                   # nothing secret in it
npm test                               # unit tests, no network
MAX_TICKS=3 POLL_MS=10000 ./node_modules/.bin/tsx agent.ts
```

The dry run reads the live book and logs a `quote_plan` or `quote_paused` line each tick, with the cost gate, band and sizes behind it. `.env.example` sets `DRY_RUN_BASE_INVENTORY` / `DRY_RUN_QUOTE_INVENTORY` so a first dry run has something to plan with. Without a waap-cli session it uses the zero address for logging only.

## Going live

1. **Log in and fund.** `waap-cli login`, then `waap-cli whoami --json` for the Sui address. Fund that address with the base and quote you intend to quote, plus a gas and cleanup reserve.
2. **Set your daily spend limit.** `waap-cli policy set --daily-spend-limit <usd>`. The limit is a threshold that asks for your approval, not a hard cap. If you need a hard boundary, use a separate account funded with only what should be on the book.
3. **Create the BalanceManager.** Run `AGENT_DRY_RUN=0 MAX_TICKS=1 ./node_modules/.bin/tsx agent.ts`. One live tick creates the manager, writes its id to `state.json` and quotes nothing. Success requires a `balance_manager_created` log and a non-empty `balanceManagerId` in `state.json`. A refused, unknown or submitted-but-not-yet-readable creation exits nonzero. In that case run `AGENT_DRY_RUN=0 npm run recover` and inspect the operation before retrying. For an unknown outcome, attach the digest or declare it not executed only after the required explorer check. A submitted transaction with a successful receipt stays pending until its manager id is persisted; rerun setup when object changes are readable to recover the id without a second create. A readable failed receipt charges its gas and clears the pending operation; fix the reported failure before retrying setup.
4. **Deposit.** For example, `AGENT_DRY_RUN=0 DEPOSIT_SUI=0.6 DEPOSIT_DEEP=30 npm run deposit`. SUI only also works: the agent bids until fills bring base into the band.
5. **Run the loop, directly.** `AGENT_DRY_RUN=0 MAX_RUN_MIN=60 ./node_modules/.bin/tsx agent.ts`. Do not launch a long run through `npm run`: on Linux, npm does not pass SIGTERM on, so stopping npm can leave the agent quoting.
6. **Stop.** Use any one of these:
   - Ctrl-C or SIGTERM the agent. It finishes the tick (the in-flight `waap-cli` call runs in its own process group, so Ctrl-C does not interrupt a signature), stops quoting, then runs cancel → settle → withdraw and checks the chain for no open order, no settled balance and an empty manager. The loop runs the same cleanup on every handled exit.
   - `AGENT_DRY_RUN=0 npm run stop`. On the same machine as a live loop, this signals the loop and waits for its cleanup, then verifies. After a crash, it runs the cleanup itself; add `-- --break-stale-lock` if the dead loop left its lock.
   - From another machine: **first make sure the original loop is stopped** (the lock is a local file, so a stop on another machine cannot see or signal it). Then run `DEEPBOOK_BALANCE_MANAGER_ID=0x… AGENT_DRY_RUN=0 npm run stop`. The login gives the owner; the manager id must be supplied.
7. **Check that cleanup succeeded.** Cleanup can fail (a refused or unknown send, a failed receipt, or residuals left on chain), and the process then exits unsuccessfully.
   - **Success:** a `cleanup_confirmed` line (with the digest and residuals) or `cleanup_verified_clean` (the manager was already empty), then `process_exit` with `cleanupOk: true`. For `npm run stop`, `stop_done` with `ok: true` and exit code 0.
   - **Failure:** `cleanup_failed` with a `stage` (`build`, `reserve`, `send`, `receipt`, `verify` or `exception`) and an `instruction`, or `cleanup_skipped` if the state file could not be written; then `process_exit` with `cleanupOk: false`, or `stop_done` with `ok: false`, and exit code 1.
   - **Recover:** `AGENT_DRY_RUN=0 npm run stop`. Cleanup is idempotent, so it is safe to rerun. If a send's outcome is unknown, `AGENT_DRY_RUN=0 npm run recover` lists it for an explorer check (without `AGENT_DRY_RUN=0` it reads the dry-run state and shows nothing pending). Orders still expire on their own within `ORDER_TTL_MIN`.

   The loop's exit code alone is not the success signal: an exit on a limit (gas cap, drawdown, taker fill, repeated failures) returns 1 even when its cleanup succeeded. Read `cleanupOk`.

`./stop-check.sh` rehearses steps 5 and 6 as a dry run: launch, duplicate refused, stop handoff, cleanup, no survivor, lock released. It runs with a replaced environment, a temporary `HOME` and a stand-in `waap-cli` that refuses to sign. It fails if anything reached a signer.

## Safety model

| Concern | What the recipe does |
|---|---|
| Two processes on one account and pool | An atomic lock (`open wx`) keyed on account, network and pool, under `LOCK_DIR`. A live holder refuses the second process. A dead one is taken over only with `--break-stale-lock`. Single host: a local file cannot stop a second machine. |
| Which manager | State and `DEEPBOOK_BALANCE_MANAGER_ID` must agree. If they disagree, every script refuses. Missing state next to a configured manager is refused unless `ADOPT_MANAGER=1`, which starts a new run with fresh budgets. |
| State | Versioned and identity-bound: owner, network, pool, and live or dry mode. Written atomically. A corrupt or unwritable file stops the loop; it is never silently reset. Fills, cursor and budgets are saved in one write. |
| A send whose result is unknown | Intent, gas reservation and client order ids are saved before signing. An unknown outcome blocks quoting and is never resent. It resolves only on transaction evidence; an empty book is not evidence. Where no evidence can be found automatically, `AGENT_DRY_RUN=0 npm run recover` records an operator's explorer check: `attach` a digest after its sender is verified, or declare `not-executed`, which charges the full reservation. Cleanup, which is idempotent, is still allowed, and a later verified cleanup supersedes earlier unknown ones. |
| Restart | Fills are backfilled from the saved cursor before quoting resumes. `FILL_SKIP_GAP=1` skips the backfill and marks the run's turnover and P&L incomplete. |
| Gas | Consumed gas only goes up: rebates never add capacity. Reservations are held until each receipt is counted. Cleanup has its own allowance beyond the cap. |

## Scripts

| Command | What |
|---|---|
| `./node_modules/.bin/tsx agent.ts` | The loop |
| `npm run deposit` | Wallet → BalanceManager (`DEPOSIT_SUI`, `DEPOSIT_DEEP`) |
| `npm run stop` | Cancel → settle → withdraw, verified; hands off to a live loop |
| `AGENT_DRY_RUN=0 npm run recover` | List a live run's pending operations; `-- attach <opId> <digest>` or `-- not-executed <opId> --checked-explorer` |
| `npm test` / `npm run typecheck` | Unit tests (no network) / `tsc --noEmit` over every script |
| `./stop-check.sh` | Dry rehearsal of launch, lock and stop |
| `npm run fills` | Walk the chain's `OrderFilled` events for this manager up to confirmed cleanup, and print spread against gas, with fees and taker/self fills |
| `npm run receipts` | Every receipt a log submitted, gas by kind |
| `npm run grade:smoke` | Grade a bounded live run: `PASS`, `PASS_WITH_DISCLOSED_EXCEPTION` or `FAIL`, plus `utility` (`DEMONSTRATED` needs a real placement and a fill). Rules are in `lib/smoke.ts` |
| `npm run refuse-probe` | One deliberate deposit above your daily limit, to see the policy engine answer |
| `npm run measure*` | Gas simulation of transaction shapes; requote-rule replay over a real price series |

Every variable, with its default and reason, is in `.env.example`.

## Known limitations

- **Occasional `InsufficientGas` (waap-cli 2.2.0).** In Standard mode `waap-cli send-tx` takes the transaction kind, and WaaP's preparation step sets the gas budget just above the estimate. When state changes before execution, a requote can fail on chain. In two mainnet runs of the previous version this happened to 4 of 134 and 2 of 11 requotes, at about 0.00018 SUI each; the next tick succeeded. None of the 16 sends in the 28 September run failed this way. The gas budget counts these failures.
- **Fills are not predicted.** The cost gate says whether a cycle *would* cover its cost. How often DEEP/SUI takers reach a quote at a given distance from the touch is a market fact that no replay of price prints can supply.
- **Fees in the input token.** On a fee-bearing pool, non-DEEP maker fees are taken as the order's input asset (quote for a bid, base for an ask). DEEP/SUI is whitelisted at zero fee, so that path is covered only by synthetic tests.
- **RPC endpoints.** Mysten's public fullnode no longer serves the JSON-RPC methods the SDK uses. The default is publicnode, with suiscan as the fallback.

## Main events

| Event | Meaning |
|---|---|
| `agent_start` | `runId`, owner, network, pool, manager, the full strategy and limits, whether this resumes an open run |
| `quote_plan` / `quote_paused` / `inventory_limited` | Each tick's decision. Carries mode, reason, band fraction, value, spread, `gate` (edge, cost, margin, required spread, touch), cancels, places, per-side keep/place/none with reasons, and gas and turnover so far |
| `op_intent` → `tx_submitted` → `tx_gas` | One send: intent saved, digest, receipt folded into the budget |
| `send_refused` / `send_outcome_unknown` / `op_resolved` / `op_still_unknown` | A send refused before signing (reservation released), or unknown and then resolved (or not) from chain evidence |
| `fill` | One of our fills: role (`maker`, `taker`, `self`), our side, price, size, fee and fee asset |
| `fill_scan` | Pages read, new fills, `completion` (`head`, `page_budget`, `end_time`) |
| `resting_reconciled`, `orders_confirmed` | The chain's view of our orders |
| `quotes_stopped` → `cleanup_started` → `cleanup_confirmed` / `cleanup_verified_clean` / `cleanup_failed` → `process_exit` | The exit lifecycle; `cleanup_confirmed` carries the digest and timestamped residuals |
| `stop_handoff`, `stop_done` | `npm run stop` |

## Layout

| Path | What |
|---|---|
| `agent.ts` | The loop |
| `deposit.ts`, `stop.ts`, `refuse-probe.ts`, `recover.ts` | One-shot scripts, all through `lib/context.ts` (lock, state, manager) |
| `lib/strategy.ts`, `lib/costs.ts`, `lib/scenario.ts` | The maker, its cost model, an offline decision simulator |
| `lib/state.ts`, `lib/lock.ts`, `lib/identity.ts`, `lib/pending.ts`, `lib/budget.ts` | Durable state, the lock, one manager, sends with intent, budgets |
| `lib/ops.ts`, `lib/ptb.ts` | Sending, receipts and cleanup; the exact transaction commands |
| `lib/waap.ts` | The waap-cli spine, RPC rotation, logger, clients |
| `lib/events.ts`, `lib/fills.ts`, `lib/spread.ts`, `lib/receipts.ts` | Event parsing (roles, fees), fill collection, FIFO spread, gas |
| `lib/smoke.ts`, `grade-smoke.ts` | The bounded-run grade |
| `lib/*.test.ts`, `lib/fixtures/` | Tests, several fed real mainnet transactions |
| `VALIDATION.md`, `evidence/` | Mainnet results, the run history, and a credential-free manifest and checker that re-derive the 28 September ledger from the chain |

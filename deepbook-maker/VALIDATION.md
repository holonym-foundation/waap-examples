# DeepBook maker: validation record

Every mainnet run of this recipe, with digests, ledgers and the bounded-run grade. The recipe page carries the summary; this file carries the detail.

All runs: Sui mainnet, DEEP/SUI pool, WaaP Standard mode, `@human.tech/waap-cli@2.2.0`, sender `0xc9afaf6e0de1cdf3f830384303f7dbd1bb9c29350f4406ca614811dda61bae8a`, BalanceManager `0xdceb4ba0957e681550518f87b62c12a5bed5d420f1cfadf156cb08be9f2dd2b5`. Digests resolve on [Suiscan](https://suiscan.xyz/mainnet).

## Re-derive the 28 September ledger yourself

[`evidence/2026-09-28-run-2.json`](./evidence/2026-09-28-run-2.json) lists every transaction that changed the sender wallet between 14:10 and 16:05 UTC on 28 September, with its gas and wallet balance change, and the two fills. It holds public chain data only.

```bash
node evidence/check-ledger.mjs    # Node 20+, no install, read-only RPC
```

The checker queries the chain for every transaction from or to the sender in that window, fails if the set differs from the manifest, sums gas (computation + storage − rebate) and wallet balance changes from each transaction's effects, reads the two `OrderFilled` events, and compares the totals with the manifest. On 29 September it printed `ok` for all six totals over 19 wallet transactions.

The earlier runs below are recorded from the saved run logs; their digests resolve, but they have no manifest.

## How a bounded run is graded

`npm run grade:smoke` grades one run from its log and the chain (rules in `lib/smoke.ts`):

- `PASS`: quoted for at least 60 minutes, every transaction succeeded, counters reconcile, and cleanup was confirmed on chain within 15 minutes of quoting stopping.
- `PASS_WITH_DISCLOSED_EXCEPTION`: every condition holds, with an exception that must be disclosed wherever the run is cited: a requote that failed on chain with `InsufficientGas` on a WaaP-set gas budget and was followed by a successful requote; cleanup confirmed later than 15 minutes; or up to 5 failed ticks while nothing was being sent.
- `FAIL`: anything else, including missing evidence.
- `utility`, graded separately: `DEMONSTRATED` needs a real placement and at least one fill, otherwise `INCONCLUSIVE`.

The grade covers a run's receipts and end state. It is not an assessment of the strategy.

## The revised maker, 28 September 2026

Settings for both runs: `ORDER_SIZE=50`, `COST_QUANTILE=median`, `COST_REPLACEMENTS_PER_CYCLE=2`, `GAS_CAP_SUI=0.10`, `MAX_DRAWDOWN_SUI=0.03`, 60 s poll, run from a laptop.

### Run 2, 14:51 to 15:56 UTC, commit `065e902`

Grade: `PASS_WITH_DISCLOSED_EXCEPTION` (4 read-only failed ticks), utility `DEMONSTRATED`.

| What | Result |
|---|---|
| Deposit | 68 DEEP + 2.55 SUI, `9ayWdJdn1qWT9njy2CppCyDx5G5SuM93AdvqJWsj99XP` |
| First requote | Both sides, `BoQipnWUfWJoSg5s3XR85bW7bnGreGKMVeqfjNxVgoGD` |
| Fills | Our bid, 50 DEEP at 0.01873, `397dDA4YyN56gNtUiPRwbN7GiHyKAagiPQSiYWpEwq4U`; then our ask, 50 DEEP at 0.01881, `3HqcEsfr2KxVZLcb9tebneXDdqfznK6zSWgyoMshXkBg`. Both taken by an outside sender, our orders resting as maker |
| Sends | 17 transactions through `waap-cli send-tx` (the deposit, 15 requotes and the cleanup). None failed, none refused, no unknown outcome |
| Read failures | 4 ticks between 15:45 and 15:50 could not read the chain (`fetch failed` from both endpoints). Nothing was being sent and nothing was resting |
| Duration | 65.4 minutes |
| Cleanup | At the run limit, cancel → settle → withdraw, `CfxyhRfjtq7gGZnhfXPCMoT4iHkXpzYszKoudUJdeCA7`. Afterwards no open orders, nothing settled, manager empty |

| Run 2 ledger | SUI |
|---|---|
| Spread: sold 50 DEEP for 0.9405, bought 50 for 0.9365 | +0.004000000 |
| Net gas over 17 transactions (deposit, 15 requotes, cleanup) | −0.020614636 |
| **Result** | **−0.016614636** |

DEEP held was 68 before and after, so there is no inventory to mark. Of the 15 requotes, 12 cancelled or re-placed both orders as the touch spread moved across the `TOUCH_MULTIPLE` limit.

**Stopped attempt, 14:19 to 14:50 UTC, same commit.** Restarting after a four-hour gap, it read fill history at 8 pages a tick and had not caught up after 30 minutes, so it was stopped by hand before quoting. Deposit `n2M9psaA88Z3pcafxjgrV8ciuodHiHL2GE5Q3Dc8yHV`, cleanup `4Y7rjA147GvFxGfDtqsgZRz3eop9Hicrtiwqjf6PSHax`. Net gas −0.001558740 SUI: the cleanup's storage rebate exceeded the deposit's gas.

| Wallet, 14:10 to 16:05 UTC (stopped attempt and run 2) | SUI | DEEP |
|---|---|---|
| Before | 2.896094463 | 68 |
| After | 2.881038567 | 68 |
| Change | −0.015055896 | 0 |

The change is run 2's −0.016614636 plus the stopped attempt's +0.001558740.

### Run 1, 09:39 to 10:30 UTC, commit `cecc96a`

Grade: `FAIL`, utility `DEMONSTRATED`. It quoted for 50.3 minutes, under the rubric's 60, and 2 ticks failed to read the chain before read-only failures were a disclosed exception.

| What | Result |
|---|---|
| Deposit | 18 DEEP + 2.05 SUI, `4BFG7Ufd4otXeCpxZSw5gKbXoZnuCaFUSFdgYSmb7tTa` |
| First requote | A 50 DEEP bid only (base share 0.14, below the band), `D5tboDbjYVTxzht8RC17m6h3c1ga4pC4GARkZA8zUSXa` |
| Fill | That bid, moved to 0.01871 (`5yAfYSYNTXaTrGckTo3y6gZxcfw6g3r3YCU3RiVt3uSD`), taken by an outside taker for 50 DEEP, `fefaAFSYfdjZmULZChbwEKCGi9wotHkiXmJGK9hemND` |
| Unknown send | At 10:04 a requote's `waap-cli` call exited with an error within 2 seconds, and the error text was not kept (since fixed: the CLI's own output is now logged). The loop recorded the outcome as unknown and sent nothing more. After the run the account's transaction history showed nothing sent between 09:51:40 and 10:29:54, and the op was resolved as not executed with `AGENT_DRY_RUN=0 npm run recover`. The cause is not known |
| Cleanup | At the run limit, `DikGzgRHwP1Vzxv8TNQSU4qZ7kA29FRS79e2XXggKG7e`. Afterwards no open orders, nothing settled, manager empty |

Wallet: 3.833048331 SUI and 18 DEEP before, 2.896094463 SUI and 68 DEEP after. That is 50 DEEP bought at 0.01871 (0.9355 SUI) plus 0.001453868 SUI of net gas over four transactions. No sell followed, so there is no realized spread; at the closing mid of 0.01878 the 50 DEEP were worth 0.9390 SUI.

### Changed after these runs, not yet run live

Commit `522af0a`:

- **Pause and resume.** On a pause caused only by the touch rule, resting orders that pass the keep rules are held, and placing resumes only after `LIQUIDITY_MIN_PAUSE_MIN` and inside the rule by `LIQUIDITY_RESUME_MARGIN`. Replaying run 2's logged touch spreads, mids and two fills (`lib/fixtures/run-2b-touch-series.json`) reproduces the live run's 15 requotes tick for tick with the change off, and gives 8 with it on, none a pause or resume. At about 0.0013 SUI per requote, run 2 would have been about −0.006 SUI. The replay assumes no further fills; an order held through a pause could have been filled.
- **Fill history on restart.** `FILL_SCAN_PAGES` defaults to 80, from the 8 that stalled the stopped attempt. DeepBook emitted about 4,700 `OrderFilled` events an hour across all pools on 28 September.
- **Read failures.** The agent keeps its own HTTP connection pool, replaces it on every endpoint failure, and logs the cause behind `fetch failed`. What caused run 2's read failures is not known: a separate Node process reached both endpoints while the loop could not.

157 unit tests pass, `tsc` is clean, and `stop-check.sh` passes against live mainnet reads with no `send-tx`.

## The previous version, 25 and 27 September 2026

The previous version (commit `f6bfee3` and earlier) quoted a fixed 20-bps spread around mid at a fixed 20 DEEP, with no inventory band, no cost gate, no post-only flag, no order expiry and a separate manual stop. These runs measured the signing path and the gas per transaction shape that the cost gate's table (`lib/costs.ts`) now uses.

### 25 September, 12:03 to 18:59 UTC, 6 h 55 m, on a server, one start

| What | Result |
|---|---|
| Deposit | 0.45 SUI, `6YALWtz3z5LAjaxReCAWVeLsdiwQYEccpmx3oFYWySrG` |
| First requote | A 20 DEEP bid at 0.02, `D7FrSZk6Xz7CvVDPFpzPvBSS2X5RBsz4rfFw4fYDKQWX` |
| First fill | That bid, `ACkSAn1J11zPsS4SB6vpTJMUmSARiT25FVxmCqy5j2Tb` |
| Transactions | 134 requotes plus the deposit and the stop; 217 ticks had nothing to change. 4 of the 134 failed on chain with `InsufficientGas` on the WaaP-set gas budget; each was followed by a successful requote |
| Signing credential | Renewed by the CLI during the run; sends continued across the renewal |
| Fills | 40: 20 bids, 20 asks, 399 DEEP bought and sold |
| Stop | `2nu2qUrfMekL1US65zu8un4R3ww2Jap6wAoE8jTuUmfv`, after which the manager held nothing |

| 25 September ledger | SUI |
|---|---|
| Realized trading result over 399 DEEP | −0.031560 |
| Net gas over 136 transactions | 0.130114 |
| **Realized result minus gas** | **−0.161674** |
| Open inventory at the end: 1 DEEP, marked | +0.000305 |

At 20 DEEP and 20 bps around 0.02 SUI, a round trip earned about 0.0008 SUI against an average requote cost of 0.00098 SUI, and DEEP drifted down while the maker held inventory. The run ended at 18:59 on its error limit after an RPC endpoint answered HTTP 403 and the rotation did not treat that as an endpoint failure (fixed: 401 and 403 now rotate, and that endpoint is no longer a default).

### 27 September, 07:51 to 08:59 UTC, `MAX_TICKS=65`, fresh clone of `f6bfee3` on a server

| What | Result |
|---|---|
| Deposit | 0.45 SUI, `AB1ViF96qtZp8RWVdJQ5WVqCMXLtSMS2yR51Hj3YEKe8` |
| Quoting | Until tick 26; after that neither side could fund a full 20 DEEP order |
| Requotes | 11: 9 succeeded; 2 failed on chain with `InsufficientGas` on WaaP-set budgets of about 0.0019 SUI (`9qv84yGFL63SFDbsA3igQjsRJMGg78pUnZHXW3WQprPp`, `7Cck513vmQ1pnFnZcuVuyJh2kCEcNqDqF69e58Yky8dA`); tick 3 then placed the bid, `2SQtDvQGHarf9f5CmBudXiZJiiJ9onE4ioZwEEyiM5Wh` |
| Fills | 4: 2 bids, 2 asks (the last a partial fill of 3 DEEP) |
| Stop | A separate manual stop 83 minutes after the loop exited, `27qXJ5TQK7r6vKVWLYhTzVEjixUoPxP8gtSpT5hhDGRb` |
| Ledger | Realized −0.000660 SUI over 23 DEEP; net gas 0.011021 SUI over 13 transactions; realized minus gas −0.011681 SUI; 17 DEEP left, marked at −0.001700 SUI |
| Grade | `PASS_WITH_DISCLOSED_EXCEPTION` (the two `InsufficientGas` failures) |

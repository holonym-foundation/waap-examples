# Mainnet round trip: 2026-10-06

Raw files for every step are in [`evidence/live-2026-10-06/`](evidence/live-2026-10-06/).

Account: a Standard-mode WaaP test wallet, Sui `0xc9afaf6e0de1cdf3f830384303f7dbd1bb9c29350f4406ca614811dda61bae8a`. The two `--yes` commands were run by a human operator; no 2FA prompt appeared on this account. Reads used `fullnode.mainnet.sui.io` gRPC.

## Step 1: supply 0.1 SUI, new obligation (operator ran)
- Attempt 1: `{"event":"error","code":"UNEXPECTED","message":"fetch failed"}`. No journal record was written, and the wallet total moved by exactly one transaction's amount (below); attempt 1 failed before sending.
- Attempt 2: exit 0, `outcome: reconciled`, digest `8KSgKvxzi6ZMUegGjQGE3DHn7NLXLfN6PZaEwCYMsbbP`, journal `3375fca8…`. Raw: `01-supply.json`.

Independent gRPC readback (`chain-supply-tx.json`, from `probes/live/readtx.mts`):
| Check | Chain | Expected | |
|---|---|---|---|
| status | success, checkpoint 330757232 | success | ✓ |
| sender / gas owner | 0xc9af…ae8a / 0xc9af…ae8a | authorized address | ✓ |
| kind sha256 | 8c7c8b1f5d305e26f2578283fbc167daf5089629e0b3334f276cecde38f16282 | journal context.kindSha256 identical | ✓ |
| gas | budget 21,472,128 MIST @100; computation 375,000 + storage 968,855,600 − rebate 948,836,592 = **20,394,008 MIST (0.020394008 SUI)** | n/a | |
| owner SUI change | −120,394,008 MIST | −(100,000,000 + 20,394,008) | ✓ |
| created | obligation `0xbebbde70…fba2` (held in the market's object table, normal SuiLend layout); owner cap `0xf4cd9255…a889` AddressOwner 0xc9af…ae8a; one `object::ID` dynamic field | exactly one obligation + one cap | ✓ |

Wallet total before (status 2026-10-05): 2.554 coins + 0.327038567 address = 2.881038567 SUI. After: 0 coins + 2.760644559 address = 2.760644559 SUI. Difference 0.120394008 = one supply + gas. ✓ (consistent with no other send; a net balance cannot prove a transaction count)

## Step 2: status (sends nothing)
`02-status.json`: one obligation `0xbebb…fba2`, suppliedSui 0.100000002, 95,173,119 cTokens, borrowCount 0, no unresolved submissions.

## Step 3: withdraw --all dry run on 0xbebb…fba2 
`03-withdraw-dryrun.json`: simulated true, estimatedSui 0.100000002, calls withdraw_ctokens → redeem…request → unstake_sui_from_staker → fulfill_liquidity_request → TransferObjects(owner) → nonce. Warning: --all may be capped by the outflow rate limiter.

## Finding: the supply left the wallet with no SUI coin objects
The only SUI coin (`0x8122e929…`, the gas coin) was **deleted** by the supply transaction, and the remainder now sits in the address balance. Cause not verified (WaaP prepares gas server-side; likely settles change to the address balance). Effect on the recipe: `planSupply` counts coin objects only, so a second `supply` from this wallet will be refused (PREFLIGHT_REFUSED) until SUI arrives as a coin object (the withdraw should deliver one via TransferObjects). Withdraw itself does not need a coin input. Not a fund-safety issue; a usability issue to document for builders.

## Step 4: withdraw --all --yes on 0xbebb…fba2 (operator ran, first attempt)
exit 0, `outcome: reconciled`, digest `3VyJFKtmcMit8CensBas8vLHtTd3gehExj6FewM1T5BM`, journal `4cd0f3dd…`, walletCreditSui 0.100000017, ctokensWithdrawn 95,173,119, residual 0 cTokens / 0 supplied / 0 borrows. Raw: `04-withdraw.json`.

Independent gRPC readback (`chain-withdraw-tx.json`):
| Check | Chain | Expected | |
|---|---|---|---|
| status | success, checkpoint 330759957 | success | ✓ |
| sender / gas owner | 0xc9af…ae8a / 0xc9af…ae8a | authorized address | ✓ |
| kind sha256 | b1269483dc2e1dae378042b36ea15674f19fcc88c83d30e794f6cb23de016e7c | journal context.kindSha256 identical | ✓ |
| gas | budget 9,887,116; 378,000 + 965,640,800 − 956,232,684 = **9,786,116 MIST** | n/a | |
| owner SUI change | +90,213,901 | 100,000,017 credit − 9,786,116 gas | ✓ |
| SUI out | new Coin<SUI> `0xe7f11665…` AddressOwner 0xc9af…ae8a | n/a | |

Gas for the withdraw was paid from the address balance (2.760644559 → 2.750858443, −9,786,116 MIST); the credit arrived as a new coin object.

## Step 5: status after (`05-status-after.json`)
Wallet 0.100000017 in coins + 2.750858443 address = 2.850858460 SUI. Obligation `0xbebb…fba2` remains with 0 cTokens, 0 supplied, 0 borrows (empty obligation and cap stay, as allowed). No unresolved submissions. Journal: 2 records, both reconciled.

## Accounting (to the MIST)
- Before: 2,881,038,567. After: 2,850,858,460. Change: **−30,180,107**.
- Gas: −20,394,008 (supply) − 9,786,116 (withdraw) = −30,180,124.
- Interest: credit 100,000,017 − principal 100,000,000 = **+17**.
- −30,180,124 + 17 = −30,180,107 ✓. Consistent with the two recorded transactions; it does not by itself rule out offsetting extra transactions. Full account history was not enumerated (the saved history query returned "Method not found" because public JSON-RPC is retired).

## Acceptance checks
| # | Item | Result |
|---|---|---|
| 1 | Both digests success, sender = authorized, gas owner = sender | ✓ |
| 2 | On-chain kind sha256 = journal kindSha256, each digest | ✓ (kind bytes preserved through WaaP) |
| 3 | Exactly one new obligation + one owner cap; zero borrows | ✓ (cap address-owned and linked to the obligation; the obligation is held by the market through a dynamic field, which is SuiLend's layout) |
| 4 | `status` sent zero transactions | ✓ by source: the status path has no send call, and `test/process.test.ts` "status sends nothing" passes. Historical transaction census not available. |
| 5 | Obligation has 0 SUI cTokens and 0 borrows after withdraw | ✓ |
| 6 | Credit ≥ principal − rounding; balance explained to the MIST | ✓ (+17 MIST interest) |
| 7 | Readbacks from chain, not only recipe JSON | ✓ (gRPC `readtx.mts`) |

**Result: all checks pass.** Gas 0.030180124 SUI; net wallet cost 0.030180107 SUI after +17 MIST interest. No fee cap was enforced by the recipe; WaaP's prepared budgets were 0.0215 and 0.0099 SUI.

## Observations for builders
- Observed budgets set by WaaP: 21,472,128 MIST (supply) and 9,887,116 MIST (withdraw); both sufficed. Net gas: 20,394,008 and 9,786,116 MIST.
- The supply consumed the wallet's only coin object; change went to the address balance. A second supply needs a coin object large enough (the withdraw delivered one of 0.100000017).
- Public-node reads failed intermittently on a hotspot; attempt 1 of supply failed before sending and was safely re-run.

## Post-run check: second supply (dry runs only, 2026-10-06)
- `supply --amount 0.1` → exit 3 PREFLIGHT_REFUSED: needs 0.15 SUI in coin objects, wallet has 0.100000017; 2.750858443 in address balance not spent.
- `supply --amount 0.04` → dry run simulated, into existing obligation `0xbebb…fba2`.
- Rule: supply ≤ coin-object SUI − 0.05 reserve. Spending the address balance would need `FundsWithdrawal` inputs, which this version deliberately rejects.

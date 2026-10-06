# suilend-waap: supply SUI to SuiLend with a WaaP wallet

New to this? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

A standalone recipe that lets a developer, or the developer's agent, use a **WaaP** wallet on Sui to:

1. **supply** an explicitly chosen amount of SUI to SuiLend's main market,
2. **inspect / monitor** the position, and
3. **withdraw** it explicitly.

Version 1 never borrows and never uses leverage. It refuses to act on any obligation that has a borrow.

> **Verification status.** Tested offline against controlled substitutes (real SuiLend SDK
> builders, a fake chain resolver, a fake `waap-cli`), and on **Sui mainnet on 2026-10-06**: one
> funded 0.1 SUI supply, `status`, and `withdraw --all` on a real WaaP wallet, each checked against
> the chain (zero residual, gas 0.030 SUI total). 2FA flows and rate-limited withdrawals are not yet
> tested live. See [What is and is not verified](#what-is-and-is-not-verified) and
> [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## How it works

```
suilend-waap ──reads──▶ Sui gRPC full node (wallet, obligation, SUI reserve)
     │ builds TransactionKind with @suilend/sdk 13.0.0 builders (no keys involved)
     │ decodes it back and checks it against the plan (allowlist, recipient, amounts, package)
     │ simulates it as the WaaP address (fail closed)
     ▼
waap-cli send-tx --chain sui:mainnet --tx <kind base64> --tx-format base64 --json --wait
     │ WaaP prepares gas, applies your policy / 2FA, signs with your WaaP key, broadcasts
     ▼
outcome: confirmed / failed on chain / rejected by WaaP / unknown → local journal
```

- **Supply transaction:** `SplitCoins(GasCoin, [amount])` → (`create_obligation` on the first
  supply) → `deposit_liquidity_and_mint_ctokens` → `deposit_ctokens_into_obligation` →
  `rebalance_staker` → (owner cap transferred to you on the first supply).
- **Withdraw transaction:** `withdraw_ctokens` → `redeem_ctokens_and_withdraw_liquidity_request`
  → `unstake_sui_from_staker` → `fulfill_liquidity_request` → SUI transferred to you. No
  oracle refresh is needed: with no borrows, SuiLend accepts stale prices for withdrawals.
- This tool never sees a password, a key or a WaaP Privilege. You log in with `waap-cli` yourself.

## Requirements

- **Node.js 24.x** (`engines: ">=24 <25"`; verified on **v24.21.0**). Transitive
  SuiLend SDK dependencies declare `^24` (`@pythnetwork/hermes-client@3.1.0`,
  `@pythnetwork/pyth-sui-js@4.0.0`) or `>=24` (`@bluefin-exchange/bluefin7k-aggregator-sdk@7.6.3`),
  so Node 20/22 are outside the declared range and Node 25 is outside `^24`. `doctor` reports
  `nodeSupported`.
- `npm ci` prints an `ERESOLVE overriding peer dependency` warning: `aftermath-ts-sdk@1.3.29`
  (pulled in by `@suilend/sdk`) wants `@mysten/sui@1.45.2` and gets 2.34.0. The recipe never
  calls aftermath code; this is a known, unverified-at-runtime peer mismatch.
- `npm audit` (2026-10-03): 2 moderate advisories, both in the dev-only test runner
  (`vitest@3.2.7` / `@vitest/mocker`: path traversal via mock redirect; fix is vitest 5, a
  major upgrade not taken here). None in the runtime dependency path.
- A WaaP account in standard mode (its `t1` key gives the Sui address), logged in with the
  bundled `waap-cli` **2.2.1**.
- SUI on that address **in coin objects**. SUI held as an address balance is not spent.
- Network access to a Sui mainnet gRPC full node. SuiLend's main market exists only on
  mainnet, so there is no testnet mode.

## Install

```bash
cd recipe
npm ci                      # exact versions from package-lock.json
npm test                    # offline tests (network is trapped), incl. multi-process tests
npm run check:contract      # checks the bundled waap-cli flags (local only, no network)
./bin/suilend-waap.mjs doctor
```

Optionally put the binary on your PATH: `npm link`, or call `./bin/suilend-waap.mjs`.

## Log in to WaaP (you do this, not the recipe)

```bash
export WAAP_CLI_SESSION_DIR="$HOME/.waap-cli-suilend"     # isolated session for this use
WAAP=./node_modules/.bin/waap-cli
printf '%s\n' "$WAAP_PASSWORD" | $WAAP login --email you@example.com --password-stdin
$WAAP whoami
```

`suilend-waap` calls the same `waap-cli` and inherits `WAAP_CLI_SESSION_DIR` / `WAAP_CLI_ENV`.
To use another `waap-cli` binary, set `WAAP_CLI_BIN=/path/to/waap-cli`. Then run `doctor`; it
warns when the version differs from 2.2.1.

## Use

```bash
suilend-waap address                         # your WaaP Sui address
suilend-waap status                          # wallet SUI, obligation(s), supplied SUI, reserve
suilend-waap status --watch 60               # monitor; prints a line per minute, marks changes

suilend-waap supply --amount 1.5             # DRY RUN: plan + safety inspection + simulation
suilend-waap supply --amount 1.5 --yes       # submit through WaaP (approve 2FA if asked)

suilend-waap withdraw --amount 0.5           # dry run
suilend-waap withdraw --amount 0.5 --yes
suilend-waap withdraw --all --yes            # everything SuiLend currently allows

suilend-waap journal                         # local record of submissions
suilend-waap journal reconcile ID --digest D # close an open record by reading D's effect from chain
suilend-waap journal ack ID                  # close an open record WITHOUT reconciling (audited)
suilend-waap journal unlock                  # remove a lock left by a dead process on this host
suilend-waap journal repair                  # unreadable journal: back up, replace bad lines with blocking records
```

| Option | Meaning |
| --- | --- |
| `--amount SUI` | Plain decimal amount, up to 9 decimals. No `max`, no exponents. Required for supply. |
| `--yes` | Actually submit. Without it, every transaction command is a dry run. |
| `--obligation-id ID` | Pick an obligation when the address owns several. |
| `--new-obligation` | Supply into a new obligation (for example, when the existing one has borrows). |
| `--gas-reserve SUI` | SUI left in the wallet for gas on supply (default 0.05). |
| `--address A` | `status`: read any address. `supply`/`withdraw`: refuse unless the WaaP account is A. |
| `--skip-simulate` | Submit without the pre-submit simulation. Not recommended. |
| `--allow-pending` | Submit although an earlier submission is not reconciled. Applies only to records WaaP reported with a digest (`unreconciled`, `mismatch`); a `submitting`/`pending` record (outcome unknown) still blocks. |
| `--grpc-url URL` | Sui gRPC endpoint (default `https://fullnode.mainnet.sui.io:443`, or `SUILEND_WAAP_GRPC_URL`). |
| `--json` | NDJSON output for agents. |

The state directory is `~/.suilend-waap` by default, or `SUILEND_WAAP_STATE_DIR`. It is created
only on the first submission.

### Withdraw amounts and cTokens

SuiLend records deposits as cTokens. `--amount X` converts X SUI into cTokens at the current rate,
rounding down. You receive at most X SUI as of planning, plus whatever interest accrues before
execution; the dry run shows `estimatedSui`. `--all` asks SuiLend for the maximum allowed. That can
be less than everything you supplied when reserve liquidity or the outflow rate limiter is tight.
In that case the remainder stays supplied, and `status` shows it.

## For agents

Use `--json`. Every line on stdout is one JSON object:

- `{"event":"awaiting_2fa","confirm_url":...}`: **show this link to the human right away.**
  The command keeps waiting until WaaP times out.
- With `"method":"phone_authz"`, waap-cli asks for a 6-digit code **on its own stdin**. The code
  can be typed only when `suilend-waap` runs in an interactive terminal; the event then carries
  `code_entry: "type the 6-digit code here…"`. Without a terminal (typical for agents), phone
  2FA cannot be completed: the run ends with `TWO_FA_TIMEOUT` (exit 5) and nothing is
  executed. Use email/app approval, or have the human run the `--yes` step in a terminal.
- `{"event":"result",...}`: success. For `--yes` transactions, success means `outcome` is
  `"reconciled"`: WaaP reported the transaction, the read node shows it **signed by the planned
  owner**, and a fresh readback shows the intended effect. Supply reports `position`
  (obligation id, owner cap id, cTokens added, supplied SUI, `borrowCount: 0`). Withdraw reports
  `walletCreditSui` (owner's SUI balance change plus gas the owner paid) and `residual` (the
  obligation after withdrawal). A digest or WaaP's "confirmed" alone is never a success.
  A dry run has `"dryRun":true` and `kindBase64`.
- `{"event":"error","code":...,"message":...,"details":...}`: branch on `code` and the exit code.
- `status --watch N --json` emits `{"event":"status","changed":bool,...}` for each check.

| Exit | Code | What the agent should do |
| ---: | --- | --- |
| 0 | none | Done. |
| 1 | `UNEXPECTED` | Report it. Do not retry a submission without first running `status`. |
| 2 | `INVALID_INPUT` | Fix the command. Nothing happened. |
| 3 | `PREFLIGHT_REFUSED` | Report the reason (balance, borrows, liquidity, limits…). Nothing was sent. |
| 4 | `SIMULATION_FAILED` | Report the reason. Nothing was sent. |
| 5 | `WAAP_REJECTED` | WaaP did not execute it (no session, policy, 2FA timeout, funds). Ask the human. |
| 6 | `ONCHAIN_FAILED` | It executed and failed; gas was spent. Report it with the digest. |
| 7 | `PENDING_UNKNOWN` | **Do not retry.** Outcome unknown, or sent but its effect is not visible yet. If the error or `journal` shows a digest, run `status` until the entry reconciles. If no digest is recorded, `status` cannot resolve it: find the matching transaction for the address, run `journal reconcile ID --digest D`, and ask the human if none is found. |
| 8 | `BLOCKED_BY_PENDING` | An earlier submission is not reconciled. Run `status`; ask the human. |
| 9 | `LOCKED` | Another process is submitting with this state directory (or a dead one left its lock: `details.stale`). Nothing was sent. Do not use `journal unlock` unless `stale` is true and the human agrees. |
| 10 | `STATE_UNREADABLE` | The journal cannot be read; open submissions are unknown. Ask the human. Nothing was sent. |
| 11 | `RECONCILE_FAILED` | The chain shows a different result (e.g. another signer, wallet not credited). Not a success; the record stays open. Ask the human. |

Agent rules:
- Always do a dry run first and show the human the amount, the obligation and any warnings.
  Add `--yes` only when the human has explicitly approved that amount.
- Never pick the amount yourself. Never retry after exit 7.
- Never use `--skip-simulate`, `--allow-pending`, `journal ack`, `journal unlock` or
  `journal repair` unless the human asks for it.
- Never weaken WaaP policy or 2FA to get a transaction through.

A WaaP Privilege, which pre-approves transactions so 2FA is skipped, is deliberately not wired
in. If you add one, scope it to the SuiLend `lending_market` functions above and pipe it with
`--privilege-stdin`.

## Safety model

| Risk | Control |
| --- | --- |
| Wrong amount | Exact decimal→MIST parsing; the decoded transaction must split exactly that amount. |
| Borrowing / leverage | No borrow code path. A move-call allowlist is checked on the decoded bytes. Obligations with borrows are refused. |
| Funds sent elsewhere | Every `TransferObjects` recipient must be the WaaP address. |
| Wrong package / market / coin | Package must equal the SDK's on-chain-selected published-at. Type args must be the main pool and SUI. Shared objects are limited to market, clock and system state. |
| Unsupported coin sources | Only `GasCoin` split, which is the same pattern waap-cli uses for its own SUI transfers. `FundsWithdrawal` inputs are rejected. |
| Doomed transaction costing gas | Full simulation as your address before submitting (fail closed). |
| Double submit after a timeout or crash | A `submitting` record (with reconciliation context) is fsynced before waap-cli starts; open records block new submissions until the effect is read back (`status`, `journal reconcile`) or a human acks. A digest alone never closes a record. |
| Two processes submitting at once | Exclusive lock file (`O_EXCL`) per state directory, held from the journal check to the final journal write; `--allow-pending` does not bypass it. |
| Corrupt / truncated journal | Any unreadable or invalid line → exit 10 for every command that reads it (including `--allow-pending`). `journal repair` keeps a backup and replaces bad lines with open, blocking records. |
| Journal write fails after sending | Exit 7 with the digest in the message; the earlier `submitting` record still blocks; `journal reconcile ID --digest D` closes it. |
| Success claimed without the result | Success needs: chain-visible tx, sender = planned owner, and readback of position/cap (supply) or credit/residual (withdraw). |
| Reads from the wrong network | The gRPC node's chain identifier must be Sui mainnet before any plan or status. |
| Phone 2FA needs waap-cli's stdin | The kind is passed in argv (it is public), the terminal's stdin goes to waap-cli, and waap-cli prompts are forwarded to stderr. |
| `--wait` exits 0 on chain failure | The `status` field is classified; `failed` → exit 6. |
| Wrong account | `--address` assertion; a different sender reported by WaaP **or** recorded on chain → exit 11, record stays open. |

### Limits of these guarantees

- The lock is a file in the state directory: one host, local filesystem. It does not protect two
  machines (or NFS) sharing a state directory, nor two different state directories for the same
  wallet. It never waits and never steals; a lock left by a killed process must be removed with
  `journal unlock`, which refuses while the recorded PID is running (`status` reports such a
  lock as `staleLock`, not as a running mutation) (PID reuse can make a dead
  holder look alive; then remove it by hand after checking no suilend-waap runs).
- If the recipe is killed while waap-cli runs, waap-cli itself may still broadcast. The fsynced
  `submitting` record covers that: it blocks until reconciled or acknowledged.
- fsync covers process kill and power loss only as far as the OS/filesystem honours it.
- Reconciliation trusts the read node. A lagging node yields exit 7 (never success). If someone
  else changes the same obligation between plan and readback (e.g. in the SuiLend app),
  reconciliation fails closed (exit 11 or 7), a false negative, not a false success.
- `journal ack` and `--allow-pending` are human overrides: ack closes a record **without**
  reconciling it (recorded as `acknowledged`, `reconciled: false`). After an ack of a record
  whose outcome was unknown, the no-duplicate guarantee for that submission is the human's
  responsibility. `--allow-pending` never skips a `submitting`/`pending` record (unknown outcome);
  it skips only records with a WaaP-reported digest, and such a send can make the earlier
  record impossible to reconcile automatically.
- Journal writes (`start`, `update`, `repair`) require the held lock handle at the library API
  too, not only in the CLI.
- `journal reconcile ID --digest D` closes a record only if D is proven to be that submission.
  Every prepared transaction carries a random 16-byte nonce in one effect-free command
  (`MakeMoveVec<vector<u8>>`, result dropped), so its kind bytes are unique to that submission;
  the record stores their SHA-256 before sending. D must have exactly those kind bytes, the
  planned sender, no other record using it, and (a candidate filter only) a checkpoint after the
  node height read before sending. A historical identical action has a different nonce, so it
  cannot close the record even when the node read lags. Otherwise exit 11 (7 if D is not
  checkpointed) and the record stays open. Records written before the nonce (no
  `identity: "nonce-v1"`) close only through `status` or an audited `journal ack`.
  Limits: identity holds as long as WaaP executes the kind bytes it was given unchanged (observed
  live on 2026-10-06 for one supply and one withdraw; if not, manual reconcile fails closed). The
  network and WaaP accepted the nonce command on that run.
- `status` reconciles open records only when it can take the lock; otherwise it lists them
  read-only with `mutationInProgress: true`. It never sends a transaction.

## What is and is not verified

**Verified offline** (`npm test`, 208 tests):
- Amount parsing, cToken math and preflight decisions, including edge cases.
- PTBs built by the **real** `@suilend/sdk` 13.0.0 functions, serialized to kind bytes, decoded
  back and inspected. A fake resolver supplies object versions; its mutability follows the Move
  source.
- The full supply/withdraw/status flows against a fake chain port and a fake `waap-cli`. This
  includes streaming of 2FA links, phone-2FA code entry, every outcome class, and journal
  blocking and resolution. The fake's event shapes and exit codes are **inferred** from the
  waap-cli 2.2.1 bundle source and its README/SKILL; the source function for each is annotated
  in `test/fixtures/fake-waap-cli.mjs`. They have not been observed from the live service.
- The flags the recipe passes exist in the real bundled `waap-cli` 2.2.1 (`commands --json`,
  run under a network trap with zero outbound attempts).
- Pure logic of the live adapter: TypeName normalization, obligation↔cap pairing, abort messages,
  and that published-at is one shared source for the SDK builders and the inspector.
- Mutation check (`npm run check:mutation`): 24 deliberate defects are each caught by the tests;
  one no-op control survives.
- Reconciliation of
  position/cap and wallet credit/residual, signer mismatch, unreadable journal, multi-process
  lock (repeated race, real OS processes through `main()`), kill-after-send restart, delayed
  object visibility, persistence failure before/after send, wrong network, and the recovery
  commands, all with a file-backed fake chain that the fake waap-cli updates on send.
- A clean copy reinstalls from the lockfile and passes on Node 24.21.0.

**Verified live on Sui mainnet (2026-10-06, [`VALIDATION.md`](VALIDATION.md)):**
- Reads (`doctor`, `status`, chain identifier, market, wallet, obligation/cap) and simulation
  against `fullnode.mainnet.sui.io` gRPC.
- WaaP login and `whoami`; WaaP preparation, signing and broadcast of the recipe's kind bytes
  with the nonce command, without a 2FA prompt on that account.
- One funded 0.1 SUI supply into a new obligation and one `withdraw --all`: both exit 0
  `outcome: "reconciled"`, sender and gas owner = the WaaP address, on-chain kind SHA-256 equal to
  the journal's (WaaP executed the bytes unchanged), zero residual, wallet change explained to the
  MIST (gas 0.020394008 + 0.009786116 SUI; +17 MIST interest).

**Not verified:**
- 2FA approval flows (email, app, phone) on a real `--yes`.
- `status --watch` looping over time against a live node.
- A withdrawal capped by liquidity or the outflow rate limiter (residual > 0).
- Deployed bytecode: the analysis is based on Move source commit `d5ba83a`, not deployed v7
  bytecode; the live run exercised only the paths above.
- Live gas cost on other accounts; WaaP sets the gas budget and the recipe enforces no fee cap.
- Whether the WaaP service's gas-coin selection covers `amount + gas` when SUI is spread over
  many small coins.

The first funded run should use a small amount, with a dry run first, and an explorer open on the digest.

## Not in scope (v1)

Borrowing, leverage, assets other than SUI, reward claiming, markets other than the main one,
sSUI/LSTs, gas-tank sponsorship, Squid (Ika) wallet mode, hosted AEX integration, workshops.

## Files

| Path | What |
| --- | --- |
| `src/cli.ts` | Commands, output, exit codes |
| `src/app.ts` | Command orchestration (journal → address → reads → plan → build → inspect → simulate → submit) |
| `src/plan.ts` | Preflight decisions and cToken math |
| `src/ptb.ts` | Supply/withdraw commands using `@suilend/sdk` builders |
| `src/inspect.ts` | Decode-and-check of kind bytes before submission |
| `src/waap.ts` | `waap-cli` runner (streaming NDJSON) and outcome classification |
| `src/journal.ts` | Append-only, fsynced, strictly validated submission journal |
| `src/lock.ts` | Per-state-directory exclusive mutation lock |
| `src/reconcile.ts` | Post-send readback rules (signer, position/cap, credit/residual) |
| `src/chain.ts` | Live Sui gRPC + SuiLend adapter (exercised on mainnet 2026-10-06) |
| `probes/live/readtx.mts` | Read a transaction back from chain: sender, gas, balance changes, kind SHA-256 |
| `test/` | Offline tests, fake `waap-cli`, network trap, fake resolver; `world-chain.ts` + `fixtures/world.mjs` (shared file-backed fake chain), `process.test.ts` (multi-process `main()` tests) |
| `scripts/` | Real-binary contract check, mutation check, evidence runner |
| `probes/` | Feasibility probes run before the build |
| `docs/GETTING-STARTED.md` | Beginner walkthrough with real mainnet outputs |
| `VALIDATION.md` | Mainnet round-trip receipt, every number checked against chain |
| `evidence/` | `waap-cli` 2.2.1 command schema; `live-2026-10-06/` raw mainnet outputs |

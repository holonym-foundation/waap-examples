# Getting started with suilend-waap

This guide takes you from nothing to a successful dry run in about 10 minutes. It then shows how to do a real supply and withdrawal with small amounts. The full reference is the [README](../README.md).

## What this does and why

SUI that sits idle in a wallet earns nothing. SuiLend is a lending market on Sui. If you supply SUI to it, borrowers pay interest on it and you receive a share of that interest. The rate changes all the time, so check it before you decide. This recipe makes no promise about yield.

`suilend-waap` is a command-line tool for a **Standard-mode WaaP account**. It supplies SUI to SuiLend's main market, shows your position, and withdraws it. The recipe never receives your password or a raw key; signing happens inside WaaP. It builds a transaction, checks it, and hands it to `waap-cli`, which asks WaaP to sign. Because the commands are plain and the output can be JSON, an AI agent can run them for you.

Example: on 2026-10-06 the SUI reserve showed a supply rate of 0.9739% APR. At that rate, 100 SUI would earn roughly 0.97 SUI over a year. The rate will differ when you read it. The tool never borrows.

## Three terms

- **Obligation**: your position in SuiLend. It is an object that holds what you have deposited.
- **cTokens**: the receipt SuiLend gives you for a deposit. Their value grows as interest accrues. On withdrawal they convert back to SUI.
- **Dry run**: the tool builds the transaction, checks it and simulates it, then stops. Nothing is sent. Every transaction command is a dry run unless you add `--yes`.

## Prerequisites

- **Node.js 24**, exactly. Run `node -v` and expect `v24.x.x`. Node 20, 22 and 25 are outside the supported range.
- **A Standard-mode WaaP account** with an email and password. Its Sui address is the one that holds your SUI. Squid mode is not supported in this version.
- **SUI in coin objects.** Sui can hold SUI in two ways: as coin objects, or as an "address balance". This tool spends only coin objects. SUI held as an address balance is not spent.
- Network access to a Sui mainnet node. SuiLend's main market exists only on mainnet, so there is no testnet mode.

## Step by step

All commands run from the `recipe` folder.

### 1. Install

```bash
cd recipe
npm ci
```

`npm ci` may print an `ERESOLVE overriding peer dependency` warning. The README lists it as known. You can continue.

### 2. Log in to WaaP

You log in yourself. The recipe never sees your password. This form hides what you type and does not leave the password in your shell history.

```bash
export WAAP_CLI_SESSION_DIR="$HOME/.waap-cli-suilend"
read -rs PW && printf '%s' "$PW" | ./node_modules/.bin/waap-cli login -e you@example.com --password-stdin; unset PW
./node_modules/.bin/waap-cli whoami
```

Type the password and press Enter. `whoami` should show your account. Sessions expire, so you may need to log in again later.

### 3. Check the setup with `doctor`

```bash
./bin/suilend-waap.mjs doctor --json
```

Expect `"nodeSupported":true` and `"waapCliVersionMatches":true`. Shortened example:

```json
{"event":"result","node":"v24.21.0","nodeSupported":true,"waapCliVersion":"2.2.1","waapCliVersionMatches":true,"chain":"sui:mainnet","grpcUrl":"https://fullnode.mainnet.sui.io:443"}
```

### 4. Read your position with `status`

```bash
./bin/suilend-waap.mjs status --json
```

This only reads. Shortened example (the address is an example, yours will differ):

```json
{"event":"result","address":"0xc9af…ae8a","chain":"sui:mainnet","wallet":{"suiInCoins":"2.554","suiInAddressBalance":"0.327038567"},"reserve":{"supplyAprPercent":"0.9739","availableToWithdrawSui":"26100188.43"},"obligations":[],"unresolvedSubmissions":[]}
```

Read these fields:

- `suiInCoins` is the SUI the tool can spend. Here, 2.554.
- `suiInAddressBalance` is SUI the tool will not spend. Here, 0.327.
- `supplyAprPercent` is the live supply rate. It changes.
- `obligations` is empty because nothing is supplied yet.

### 5. Supply: dry run

Start with a small amount.

```bash
./bin/suilend-waap.mjs supply --amount 0.1 --new-obligation --json
```

Your first supply creates an obligation either way. `--new-obligation` makes that explicit, and later it keeps a new supply separate from an existing position. Shortened example:

```json
{"event":"result","dryRun":true,"action":"supply","amountSui":"0.1","obligation":"new (created in this transaction)","expectedCtokens":"95174110","simulated":true,"warnings":["The reserve's USD deposit limit and rate limits are only checked by the pre-submit simulation."]}
```

`"dryRun":true` means nothing was sent. `"simulated":true` means the transaction ran successfully in simulation. `expectedCtokens` is the receipt you would get. If you reach this point, you have a working setup.

### 6. Supply for real

Run the same command with `--yes`. WaaP may ask you to approve with 2FA. If it prints a confirmation link, open it.

```bash
./bin/suilend-waap.mjs supply --amount 0.1 --new-obligation --yes
```

Success means the result shows `"outcome":"reconciled"` and exit code 0. Check the transaction digest in a Sui explorer.

### 7. Check the position

```bash
./bin/suilend-waap.mjs status
```

`obligations` should now list your position with the supplied SUI.

### 8. Withdraw: dry run, then real

```bash
./bin/suilend-waap.mjs withdraw --all --json
./bin/suilend-waap.mjs withdraw --all --yes
```

The dry run shows `estimatedSui`, simulated against your real position. To take out part of it, use `--amount X` instead of `--all`. If you own several obligations, add `--obligation-id ID`. `--all` asks SuiLend for the maximum it allows. That can be less than everything you supplied when the market is short of liquidity. The rest stays supplied, and `status` shows it.

## Using it from an agent

Use `--json` so every output line is one JSON object. The README's "For agents" section has the full rules. The three that matter most:

1. Always run a dry run first, and show the human the amount and any warnings.
2. The human chooses the amount. The agent adds `--yes` only after the human approves that amount.
3. After exit code 7, never retry. Run `status` instead.

Example prompt:

> Use the suilend-waap recipe in `./recipe`. Run `status --json` and tell me my balances and the current supply rate. Then run a dry run of `supply --amount 0.1 --json` and show me the result and warnings. Do not add `--yes` until I reply with the amount I approve. If any command exits with code 7, stop and run `status`.

Phone-based 2FA needs a terminal, so an agent without one cannot finish it. Use email or app approval, or run the `--yes` step yourself.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `{"code":"UNEXPECTED","message":"fetch failed"}` | The network to the public Sui node was flaky. On a phone hotspot about half of status reads failed this way. | Rerun `status`. It is safe. After a `--yes` send, never resend. Run `status` first. |
| `NO_SESSION` or exit 5 | WaaP has no session, or rejected the request (policy, funds). Sessions expire. | Log in again (step 2). If WaaP prints a 2FA link, approve it. |
| Exit 5 with `TWO_FA_TIMEOUT` | The 2FA approval did not arrive in time, or phone 2FA had no terminal. Nothing was executed. | Approve faster, use email or app approval, or run it in a terminal. |
| Exit 3 or 4 | The tool refused before sending (balance, borrows, liquidity, limits) or the simulation failed. Nothing was sent. | Read the `message`. Fix the cause, for example a smaller amount. |
| Exit 7 | The outcome is unknown, or the transaction was sent but its effect is not visible yet. | Do not retry. Run `journal --json`. If the record has a digest, run `status` until it reconciles. If it has no digest, `status` cannot resolve it: find the transaction in a Sui explorer for your address, then run `journal reconcile ID --digest D`. If you find none, stop and ask for help. |
| Exit 3 `PREFLIGHT_REFUSED` with "held as an address balance" | Your coin objects do not cover the amount plus the 0.05 SUI gas reserve. The rest is in the address balance, which the tool does not spend. | Supply a smaller amount (coin SUI minus 0.05), or withdraw first; a withdrawal returns SUI as a coin. |
| `nodeSupported` is `false` | Node is not 24.x. | Install Node 24 and run `npm ci` again. |

## What a real round trip looked like (mainnet, 2026-10-06)

One supply of 0.1 SUI into a new obligation, one `status`, one `withdraw --all`, on a WaaP wallet with no 2FA prompt:

| Step | Result | Gas |
| --- | --- | --- |
| supply 0.1 | reconciled; 95,173,119 cTokens; 0 borrows | 0.020394008 SUI |
| withdraw --all | reconciled; 0.100000017 SUI back; 0 cTokens left | 0.009786116 SUI |

The round trip cost about 0.03 SUI in gas and earned 17 MIST (0.000000017 SUI) of interest in the 10 minutes it was supplied. Every transaction pays gas, and the amount varies with the transaction and the state it touches, so small or short supplies lose money. At the 0.97% rate seen that day, 0.03 SUI of gas is roughly a year of interest on 3 SUI, or a month of interest on about 37 SUI. Supply amounts and durations where the interest clearly beats the gas.

The full receipt, with every number checked against the chain, is in [`VALIDATION.md`](../VALIDATION.md).

### Check a transaction on chain yourself

```bash
npx tsx probes/live/readtx.mts <digest>
```

It prints the sender, who paid gas, the gas used, the SUI balance changes and the hash of the transaction's instructions. Compare `kindSha256` with the `context.kindSha256` that `journal --json` recorded before sending; equal hashes mean WaaP executed exactly the transaction the recipe built.

### After your first supply, check your coin objects

On the live run, the supply used the wallet's only SUI coin object to pay for itself, and the change went to the address balance. `status` then showed `suiInCoins: "0"`. After the withdrawal, the wallet had one coin of 0.100000017 SUI. A second supply dry run of 0.1 SUI was refused:

```json
{"event":"error","code":"PREFLIGHT_REFUSED","message":"Insufficient SUI: supplying 0.1 SUI and keeping 0.05 SUI for gas needs 0.15 SUI in coin objects, wallet has 0.100000017. 2.750858443 SUI is held as an address balance, which this recipe does not spend."}
```

A dry run of 0.04 SUI from the same wallet simulated successfully. The rule: you can supply up to your coin-object SUI minus the 0.05 SUI gas reserve. Your SUI in the address balance is still yours; this version of the recipe does not spend it.

## Tested so far

- Offline tests pass (208 of 208), using controlled substitutes for the chain and for `waap-cli`.
- On mainnet: read, supply dry run, a funded supply, `status`, a withdraw dry run and a funded withdraw all passed on 2026-10-06, with zero residual.
- Not tested live: 2FA approval flows, a withdrawal capped by the rate limiter, more than one obligation.

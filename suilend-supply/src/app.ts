import { createHash, randomBytes } from "node:crypto";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { formatMist, parseSuiAmount } from "./amount.js";
import { DEFAULT_GAS_RESERVE_MIST, SUI_COIN_TYPE, WAAP_CHAIN } from "./constants.js";
import { RecipeError } from "./errors.js";
import { inspectKind } from "./inspect.js";
import type { Journal, JournalRecord, ReconcileContext } from "./journal.js";
import { acquireLock, type HeldLock } from "./lock.js";
import { reconcile } from "./reconcile.js";
import { ctokensToMist, planSupply, planWithdraw, type SupplyPlan, type WithdrawPlan } from "./plan.js";
import { addSupplyCommands, addWithdrawCommands, type SuilendCalls } from "./ptb.js";
import BigNumber from "bignumber.js";
import type { ChainPort, ObligationSnapshot, SuiReserveSnapshot } from "./types.js";
import { waapSendKind, waapSuiAddress, type WaapOptions } from "./waap.js";

export interface Reporter {
  /** Human progress (stderr). */
  progress(msg: string): void;
  /** Machine event that must reach the user/agent immediately (e.g. a 2FA approval link). */
  event(name: string, data: Record<string, unknown>): void;
}

export interface Deps {
  chain: () => Promise<{ port: ChainPort; suilend: SuilendCalls }>;
  waap: WaapOptions;
  journal: Journal;
  reporter: Reporter;
  /** Post-send readback: attempts and delay between them (delayed object visibility). */
  reconcile?: { attempts: number; delayMs: number };
}

/** Sui mainnet genesis checkpoint digest (base58); hex prefix 35834a8a. */
export const MAINNET_CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const DEFAULT_RECONCILE = { attempts: 10, delayMs: 3000 };

async function assertMainnet(port: ChainPort) {
  const id = await port.chainIdentifier();
  if (id !== MAINNET_CHAIN_ID) {
    throw new RecipeError(
      "PREFLIGHT_REFUSED",
      `The gRPC node serves chain ${id}, not Sui mainnet (${MAINNET_CHAIN_ID}). SuiLend's main market and WaaP's ${WAAP_CHAIN} signing are mainnet only.`,
    );
  }
}

const sameAddress = (a: string, b: string) => normalizeSuiAddress(a) === normalizeSuiAddress(b);

async function signerAddress(deps: Deps, expected?: string): Promise<string> {
  const address = await waapSuiAddress(deps.waap);
  if (expected && !sameAddress(expected, address)) {
    throw new RecipeError(
      "PREFLIGHT_REFUSED",
      `--address ${expected} does not match the logged-in WaaP account's Sui address ${address}`,
    );
  }
  return address;
}

function assertNoOpenSubmissions(deps: Deps, address: string | undefined, allowPending: boolean | undefined) {
  const open = deps.journal.open(address); // reads (and validates) the journal even with --allow-pending
  // --allow-pending only skips records whose transaction WaaP reported with a digest. A record
  // whose send outcome is unknown (submitting/pending) may still land: sending again could
  // duplicate it, so it always blocks until reconciled or explicitly acknowledged.
  const unknown = open.filter((r) => r.state === "submitting" || r.state === "pending");
  if (allowPending && unknown.length > 0) {
    throw new RecipeError(
      "BLOCKED_BY_PENDING",
      `${unknown.length} earlier submission(s) have an unknown outcome and may still execute; --allow-pending does not ` +
        `override these. Run "status", or "journal reconcile <id> --digest D" / "journal ack <id>" after checking an explorer.`,
      { open: unknown },
    );
  }
  if (allowPending) return;
  if (open.length > 0) {
    throw new RecipeError(
      "BLOCKED_BY_PENDING",
      `${open.length} earlier submission(s) are not reconciled. Run "status" to reconcile them from chain ` +
        `(or "journal reconcile <id> --digest D" / "journal ack <id>" after checking an explorer) before submitting again.`,
      { open },
    );
  }
}

/**
 * Run a mutating command (`--yes`) under the state directory's exclusive lock: from the journal
 * check through the final journal write. Dry runs take no lock (they send nothing).
 */
async function underLock<T>(deps: Deps, mutate: boolean | undefined, label: string, fn: (lock?: HeldLock) => Promise<T>): Promise<T> {
  if (!mutate) return fn();
  const lock = acquireLock(deps.journal.dir, label);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/**
 * Try to close open journal entries by reading their effect back from chain (same rule as a
 * fresh submission: a successful digest alone is not enough). Caller must hold the lock.
 */
async function resolveOpen(deps: Deps, lock: HeldLock, port: ChainPort, address: string): Promise<JournalRecord[]> {
  const stillOpen: JournalRecord[] = [];
  for (const rec of deps.journal.open(address)) {
    if (rec.state === "mismatch") {
      stillOpen.push(rec);
      continue;
    }
    const r = await reconcile(port, rec);
    if (r.state === "reconciled") deps.journal.update(lock, rec.id, "reconciled", { note: "reconciled by status", report: r.report });
    else if (r.state === "failed") deps.journal.update(lock, rec.id, "failed", { note: r.reason });
    else if (r.state === "mismatch") {
      deps.journal.update(lock, rec.id, "mismatch", { note: r.reason });
      stillOpen.push({ ...rec, state: "mismatch", note: r.reason });
    } else stillOpen.push({ ...rec, note: r.reason });
  }
  return stillOpen;
}

function depositHeadroomMist(r: SuiReserveSnapshot): bigint {
  const supplied = BigInt(r.totalSupplyMist.integerValue(BigNumber.ROUND_CEIL).toFixed(0));
  return r.depositLimitMist > supplied ? r.depositLimitMist - supplied : 0n;
}

export async function statusCommand(deps: Deps, opts: { address?: string }) {
  const address = opts.address ?? (await waapSuiAddress(deps.waap));
  deps.journal.all(); // unreadable journal → STATE_UNREADABLE, never "nothing unresolved"
  const { port } = await deps.chain();
  await assertMainnet(port);
  // Only resolve (write) while no mutation is running; otherwise report records read-only.
  let lock: HeldLock | undefined;
  let lockError: RecipeError | undefined;
  try {
    lock = acquireLock(deps.journal.dir, "status");
  } catch (e) {
    if (!(e instanceof RecipeError && e.code === "LOCKED")) throw e;
    lockError = e;
  }
  let unresolved: JournalRecord[];
  try {
    unresolved = lock ? await resolveOpen(deps, lock, port, address) : deps.journal.open(address);
  } finally {
    lock?.release();
  }
  const [market, wallet, obligations] = await Promise.all([
    port.readMarket(),
    port.readWallet(address),
    port.readObligations(address),
  ]);
  const r = market.sui;
  return {
    address,
    chain: WAAP_CHAIN,
    readAt: new Date(market.readAtMs).toISOString(),
    wallet: {
      suiInCoins: formatMist(wallet.coinObjectMist),
      suiInAddressBalance: formatMist(wallet.addressBalanceMist),
    },
    reserve: {
      supplyAprPercent: r.depositAprPercent,
      availableToWithdrawSui: formatMist(r.availableMist),
      depositLimitHeadroomSui: formatMist(depositHeadroomMist(r)),
    },
    obligations: obligations.map((o) => ({
      obligationId: o.obligationId,
      suppliedSui: formatMist(ctokensToMist(r, o.suiCtokens)),
      suiCtokens: o.suiCtokens.toString(),
      otherDeposits: o.otherDeposits.map((d) => ({ coinType: d.coinType, ctokens: d.ctokens.toString() })),
      borrowCount: o.borrowCount,
      managedByRecipe: o.borrowCount === 0,
    })),
    unresolvedSubmissions: unresolved,
    ...(lockError
      ? lockError.details?.stale
        ? { mutationInProgress: false, staleLock: lockError.details.holder, lockNote: lockError.message }
        : { mutationInProgress: true, lockNote: lockError.message }
      : {}),
  };
}

type Prepared<P> = { plan: P; kindBase64: string; calls: string[]; simulated: boolean };

async function prepare<P extends SupplyPlan | WithdrawPlan>(
  deps: Deps,
  port: ChainPort,
  suilend: SuilendCalls,
  plan: P,
  market: Awaited<ReturnType<ChainPort["readMarket"]>>,
  skipSimulate: boolean | undefined,
): Promise<Prepared<P>> {
  // Follow-up 3: a fresh random nonce per prepared transaction makes its kind bytes unique.
  const nonce = randomBytes(16);
  const kind = await port.buildKind((tx) =>
    plan.action === "supply" ? addSupplyCommands(tx, suilend, plan, nonce) : addWithdrawCommands(tx, suilend, plan, nonce),
  );
  const { calls } = inspectKind(kind, plan, market, nonce);
  let simulated = false;
  if (!skipSimulate) {
    deps.reporter.progress("Simulating the transaction against current chain state…");
    const sim = await port.simulate(kind, plan.owner);
    if (!sim.ok) {
      throw new RecipeError("SIMULATION_FAILED", `Simulation failed, nothing was submitted: ${sim.reason}`, {
        abort: sim.abort,
      });
    }
    simulated = true;
  }
  return { plan, kindBase64: toBase64(kind), calls, simulated };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Journal write after a possible send: a failure must not lose the digest. */
function recordAfterSend(deps: Deps, lock: HeldLock, id: string, state: Parameters<Journal["update"]>[2], fields: Partial<JournalRecord>, digest?: string) {
  try {
    deps.journal.update(lock, id, state, fields);
  } catch (e) {
    throw new RecipeError(
      "PENDING_UNKNOWN",
      `The transaction was handed to WaaP${digest ? ` (digest ${digest})` : ""}, but recording the outcome failed: ${(e as Error).message}. ` +
        `Journal record ${id} stays open and blocks new submissions. Fix the state directory, then run ` +
        (digest ? `"journal reconcile ${id} --digest ${digest}".` : `"status".`),
      { digest, journalId: id },
    );
  }
}

async function submit(
  deps: Deps,
  lock: HeldLock,
  port: ChainPort,
  prepared: Prepared<SupplyPlan | WithdrawPlan>,
  summary: string,
  context: ReconcileContext,
) {
  const { plan } = prepared;
  // Identity of this submission for later manual recovery: the exact kind bytes, plus the chain's
  // checkpoint height read now, before anything is sent (its transaction must land later).
  // If this read fails, nothing is sent.
  const checkpointBefore = await port.latestCheckpoint();
  context = {
    ...context,
    kindSha256: createHash("sha256").update(Buffer.from(prepared.kindBase64, "base64")).digest("hex"),
    checkpointBefore: checkpointBefore.toString(),
    // the kind carries this submission's random nonce, so kindSha256 identifies it (follow-up 3)
    identity: "nonce-v1",
  };
  // Durable (fsync) before waap-cli starts: if this fails, nothing is sent.
  const id = deps.journal.start(lock, { action: plan.action, address: plan.owner, summary, context });
  deps.reporter.progress(`Submitting through WaaP (${WAAP_CHAIN}). Approve the request if WaaP asks for 2FA…`);
  const interactive = deps.waap.childStdin !== undefined ? deps.waap.childStdin !== "ignore" : !!process.stdin.isTTY;
  let outcome;
  try {
    outcome = await waapSendKind(prepared.kindBase64, {
      ...deps.waap,
      onEvent: (e) => {
        if (e.event === "awaiting_2fa") {
          const phone = e.method === "phone_authz";
          deps.reporter.event("awaiting_2fa", {
            method: e.method,
            confirm_url: e.confirm_url,
            expires_in_seconds: e.expires_in_seconds,
            ...(phone ? { code_entry: interactive ? "type the 6-digit code here and press Enter" : "impossible: no terminal attached" } : {}),
          });
          if (phone && !interactive) {
            deps.reporter.progress(
              "WARNING: WaaP asks for a phone 2FA code, which can only be typed into an interactive terminal. " +
                "This run cannot complete it and will end with a 2FA timeout (nothing is executed).",
            );
          }
        }
      },
      onText: (line) => deps.reporter.progress(`[waap-cli] ${line}`),
    });
  } catch (e) {
    recordAfterSend(deps, lock, id, "pending", { note: `runner error: ${(e as Error).message}` });
    throw new RecipeError("PENDING_UNKNOWN", `waap-cli could not be run to completion: ${(e as Error).message}`, { journalId: id });
  }

  switch (outcome.kind) {
    case "rejected":
      recordAfterSend(deps, lock, id, "rejected", { note: outcome.waapCode });
      throw new RecipeError("WAAP_REJECTED", `WaaP did not execute the transaction (${outcome.waapCode}): ${outcome.message}`, {
        waapCode: outcome.waapCode,
        journalId: id,
      });
    case "unknown":
      recordAfterSend(deps, lock, id, "pending", { digest: outcome.digest, note: outcome.message }, outcome.digest);
      throw new RecipeError(
        "PENDING_UNKNOWN",
        `Outcome unknown (${outcome.message}). Do NOT resubmit; ` +
          (outcome.digest
            ? `run "status" until it resolves (digest ${outcome.digest})`
            : `no digest is known, so "status" cannot resolve it. Find the matching transaction for this ` +
              `address, then run "journal reconcile ${id} --digest <digest>"; if none can be found, ask the human`),
        { digest: outcome.digest, journalId: id },
      );
  }

  const digest = outcome.digest;
  if (outcome.from && !sameAddress(outcome.from, plan.owner)) {
    const reason = `WaaP reports sender ${outcome.from}, but the plan was made for ${plan.owner}`;
    recordAfterSend(deps, lock, id, "mismatch", { digest, note: reason }, digest);
    throw new RecipeError("RECONCILE_FAILED", `${reason} (digest ${digest}). Not a success: check both accounts; journal record ${id} stays open.`, {
      digest,
      journalId: id,
    });
  }
  recordAfterSend(deps, lock, id, "unreconciled", { digest, note: `WaaP reported ${outcome.kind}` }, digest);

  const { attempts, delayMs } = deps.reconcile ?? DEFAULT_RECONCILE;
  const rec: JournalRecord = { id, at: "", state: "unreconciled", action: plan.action, address: plan.owner, digest, context };
  let last = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    let r;
    try {
      r = await reconcile(port, rec);
    } catch (e) {
      last = `chain read failed: ${(e as Error).message}`;
      continue;
    }
    if (r.state === "reconciled") {
      recordAfterSend(deps, lock, id, "reconciled", { report: r.report }, digest);
      return { submitted: true, outcome: "reconciled", journalId: id, ...r.report };
    }
    if (r.state === "failed") {
      recordAfterSend(deps, lock, id, "failed", { note: r.reason }, digest);
      throw new RecipeError("ONCHAIN_FAILED", `Transaction ${digest} executed but failed on chain (gas was spent)`, { digest, journalId: id });
    }
    if (r.state === "mismatch") {
      recordAfterSend(deps, lock, id, "mismatch", { note: r.reason }, digest);
      throw new RecipeError("RECONCILE_FAILED", `${r.reason}. Not a success; journal record ${id} stays open.`, { digest, journalId: id });
    }
    last = r.reason;
  }
  recordAfterSend(deps, lock, id, "unreconciled", { note: last }, digest);
  throw new RecipeError(
    "PENDING_UNKNOWN",
    `WaaP reported ${outcome.kind} for ${digest}, but the chain does not show the intended result yet (${last}). ` +
      `Do NOT resubmit; run "status" until it reconciles.`,
    { digest, journalId: id },
  );
}

export interface TxCommandOptions {
  address?: string;
  obligationId?: string;
  yes?: boolean;
  skipSimulate?: boolean;
  allowPending?: boolean;
}

function describe(prepared: Prepared<SupplyPlan | WithdrawPlan>, extra: Record<string, unknown>) {
  return {
    ...extra,
    owner: prepared.plan.owner,
    chain: WAAP_CHAIN,
    calls: prepared.calls,
    simulated: prepared.simulated,
    warnings: prepared.plan.warnings,
    kindBase64: prepared.kindBase64,
  };
}

export async function supplyCommand(
  deps: Deps,
  opts: TxCommandOptions & { amount?: string; gasReserve?: string; newObligation?: boolean },
) {
  const amountMist = parseSuiAmount(opts.amount);
  const gasReserveMist = opts.gasReserve === undefined ? DEFAULT_GAS_RESERVE_MIST : parseSuiAmount(opts.gasReserve);
  return underLock(deps, opts.yes, `supply ${formatMist(amountMist)}`, async (lock) => {
  assertNoOpenSubmissions(deps, undefined, opts.allowPending);
  const owner = await signerAddress(deps, opts.address);

  const { port, suilend } = await deps.chain();
  await assertMainnet(port);
  const [market, wallet, obligations] = await Promise.all([
    port.readMarket(),
    port.readWallet(owner),
    port.readObligations(owner),
  ]);
  const plan = planSupply({
    amountMist,
    gasReserveMist,
    wallet,
    market,
    obligations,
    obligationId: opts.obligationId,
    newObligation: opts.newObligation,
  });
  const prepared = await prepare(deps, port, suilend, plan, market, opts.skipSimulate);
  const summary = `supply ${formatMist(amountMist)} SUI`;
  const description = describe(prepared, {
    action: "supply",
    amountSui: formatMist(amountMist),
    coinType: SUI_COIN_TYPE,
    obligation: plan.obligation.kind === "new" ? "new (created in this transaction)" : plan.obligation.obligationId,
    expectedCtokens: plan.expectedCtokens.toString(),
  });
  if (!opts.yes) return { dryRun: true, ...description };
  const existing = plan.obligation.kind === "existing" ? plan.obligation : undefined;
  const context: ReconcileContext = {
    obligationIdsBefore: obligations.map((o) => o.obligationId),
    obligationId: existing?.obligationId,
    ctokensBefore: existing?.obligation.suiCtokens.toString(),
    amountMist: amountMist.toString(),
    expectedCtokens: plan.expectedCtokens.toString(),
  };
  return { ...description, ...(await submit(deps, lock!, port, prepared, summary, context)) };
  });
}

export async function withdrawCommand(deps: Deps, opts: TxCommandOptions & { amount?: string; all?: boolean }) {
  if (opts.all && opts.amount !== undefined) {
    throw new RecipeError("INVALID_INPUT", "Use either --amount or --all, not both");
  }
  const amountMist = opts.all ? undefined : parseSuiAmount(opts.amount);
  return underLock(deps, opts.yes, opts.all ? "withdraw all" : `withdraw ${formatMist(amountMist!)}`, async (lock) => {
  assertNoOpenSubmissions(deps, undefined, opts.allowPending);
  const owner = await signerAddress(deps, opts.address);

  const { port, suilend } = await deps.chain();
  await assertMainnet(port);
  const [market, wallet, obligations] = await Promise.all([
    port.readMarket(),
    port.readWallet(owner),
    port.readObligations(owner),
  ]);
  const plan = planWithdraw({ amountMist, all: opts.all, wallet, market, obligations, obligationId: opts.obligationId });
  const prepared = await prepare(deps, port, suilend, plan, market, opts.skipSimulate);
  const summary = plan.all ? "withdraw all SUI" : `withdraw ${formatMist(amountMist!)} SUI`;
  const description = describe(prepared, {
    action: "withdraw",
    obligation: plan.obligationId,
    all: plan.all,
    ctokens: plan.all ? "max" : plan.ctokens.toString(),
    estimatedSui: formatMist(plan.estimatedMist),
  });
  if (!opts.yes) return { dryRun: true, ...description };
  const target = obligations.find((o) => o.obligationId === plan.obligationId) as ObligationSnapshot;
  const context: ReconcileContext = {
    obligationIdsBefore: obligations.map((o) => o.obligationId),
    obligationId: plan.obligationId,
    ctokensBefore: target.suiCtokens.toString(),
    withdrawCtokens: plan.all ? undefined : plan.ctokens.toString(),
    withdrawAll: plan.all,
    estimatedMist: plan.estimatedMist.toString(),
  };
  return { ...description, ...(await submit(deps, lock!, port, prepared, summary, context)) };
  });
}

/**
 * Reconcile one open record against a digest supplied by the user (e.g. found on an explorer
 * after the recipe lost it). Same rule as a fresh submission; only "reconciled" closes it as
 * a success, "failed" closes it as failed, anything else leaves it open.
 */
export async function journalReconcileCommand(deps: Deps, opts: { id: string; digest: string }) {
  const lock = acquireLock(deps.journal.dir, "journal reconcile");
  try {
    const rec = deps.journal.latest().find((r) => r.id === opts.id);
    if (!rec) throw new RecipeError("INVALID_INPUT", `no journal record ${opts.id}`);
    if (!["submitting", "pending", "unreconciled"].includes(rec.state)) {
      throw new RecipeError("INVALID_INPUT", `record ${opts.id} is ${rec.state}; only submitting/pending/unreconciled records can be reconciled`);
    }
    if (rec.digest && rec.digest !== opts.digest) {
      throw new RecipeError("INVALID_INPUT", `record ${opts.id} already has digest ${rec.digest}`);
    }
    const owner = deps.journal.latest().find((r) => r.id !== rec.id && r.digest === opts.digest);
    if (owner) {
      throw new RecipeError("INVALID_INPUT", `digest ${opts.digest} already belongs to journal record ${owner.id} (${owner.state}); one digest closes one record`);
    }
    const { port } = await deps.chain();
    await assertMainnet(port);
    // A user-supplied digest must be proven to be this submission's transaction (R1): same kind
    // bytes as the ones handed to waap-cli. Sender and position checks alone cannot prove it,
    // and a failed transaction never reaches the position checks.
    const tx = await port.transactionInfo(opts.digest);
    if (tx.status === "not_found") throw new RecipeError("PENDING_UNKNOWN", `transaction ${opts.digest} is not visible on the read node; record ${rec.id} left open`, { journalId: rec.id });
    // Equal kind bytes only identify the action's shape: an earlier identical supply has the same
    // kind. The transaction must also have executed after this record was opened (chain clock).
    if (rec.context?.checkpointBefore && tx.kindSha256 === rec.context.kindSha256 && tx.checkpoint === undefined) {
      throw new RecipeError("PENDING_UNKNOWN", `transaction ${opts.digest} is not checkpointed yet; record ${rec.id} left open`, { journalId: rec.id });
    }
    const after = rec.context?.checkpointBefore !== undefined && tx.checkpoint !== undefined && tx.checkpoint > BigInt(rec.context.checkpointBefore);
    // Follow-up 3: the checkpoint bound only filters candidates (a lagging node can defeat it).
    // Identity comes from the kind bytes, which carry this submission's random nonce.
    if (rec.context?.identity !== "nonce-v1" || !rec.context.kindSha256 || !rec.context.checkpointBefore || tx.kindSha256 !== rec.context.kindSha256 || !after) {
      throw new RecipeError(
        "RECONCILE_FAILED",
        `transaction ${opts.digest} is not proven to be the one submitted for record ${rec.id} ` +
          (rec.context?.identity !== "nonce-v1" || !rec.context.kindSha256 || !rec.context.checkpointBefore
            ? `(the record has no unique submission identity; written by an older version)`
            : tx.kindSha256 !== rec.context.kindSha256
              ? `(its transaction kind differs from the planned one)`
              : `(it executed in checkpoint ${tx.checkpoint}, not after checkpoint ${rec.context.checkpointBefore} when this submission was opened)`) +
          `; record left open. If you are sure of the outcome, use "journal ack ${rec.id}" (audited, never a success).`,
        { journalId: rec.id, digest: opts.digest },
      );
    }
    const r = await reconcile(port, { ...rec, digest: opts.digest });
    if (r.state === "reconciled") {
      deps.journal.update(lock, rec.id, "reconciled", { digest: opts.digest, report: r.report, note: "reconciled with a user-supplied digest" });
      return { journalId: rec.id, outcome: "reconciled", ...r.report };
    }
    if (r.state === "failed") {
      deps.journal.update(lock, rec.id, "failed", { digest: opts.digest, note: r.reason });
      throw new RecipeError("ONCHAIN_FAILED", r.reason, { journalId: rec.id, digest: opts.digest });
    }
    if (r.state === "mismatch") throw new RecipeError("RECONCILE_FAILED", `${r.reason}; record ${rec.id} left unchanged`, { journalId: rec.id });
    throw new RecipeError("PENDING_UNKNOWN", `${r.reason}; record ${rec.id} left open`, { journalId: rec.id });
  } finally {
    lock.release();
  }
}

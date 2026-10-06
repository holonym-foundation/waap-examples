import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import { formatMist } from "./amount.js";
import type { JournalRecord } from "./journal.js";
import { ctokensToMist } from "./plan.js";
import type { ChainPort, ObligationSnapshot } from "./types.js";

export type Reconciliation =
  | { state: "reconciled"; report: Record<string, unknown> }
  | { state: "not_yet"; reason: string }
  | { state: "failed"; reason: string }
  | { state: "mismatch"; reason: string };

const sameId = (a: string, b: string) => normalizeSuiObjectId(a) === normalizeSuiObjectId(b);

function positionView(o: ObligationSnapshot, market: Awaited<ReturnType<ChainPort["readMarket"]>>) {
  return {
    obligationId: o.obligationId,
    capId: o.capId,
    suiCtokens: o.suiCtokens.toString(),
    suppliedSui: formatMist(ctokensToMist(market.sui, o.suiCtokens)),
    borrowCount: o.borrowCount,
  };
}

/**
 * Decide from fresh chain reads whether a submission had exactly its intended effect for the
 * planned owner. Pure decision over ChainPort reads; used right after sending and by `status`
 * for records left open by an earlier run. "not_yet" means "not visible yet": the record stays
 * open and nothing new may be sent.
 */
export async function reconcile(port: ChainPort, rec: JournalRecord): Promise<Reconciliation> {
  const ctx = rec.context;
  if (!rec.digest) return { state: "not_yet", reason: "no transaction digest is known for this submission" };
  if (!ctx || !rec.action || !rec.address) return { state: "not_yet", reason: "record has no reconciliation context (written by an older version)" };
  const owner = normalizeSuiAddress(rec.address);

  const tx = await port.transactionInfo(rec.digest);
  if (tx.status === "not_found") return { state: "not_yet", reason: `transaction ${rec.digest} is not visible on the read node yet` };
  if (normalizeSuiAddress(tx.sender) !== owner) {
    return { state: "mismatch", reason: `transaction ${rec.digest} was signed by ${tx.sender}, not the planned owner ${owner}` };
  }
  if (tx.status === "failure") return { state: "failed", reason: `transaction ${rec.digest} executed and failed on chain (gas was spent)` };

  const ownerChange = tx.suiChangeMist[owner] ?? 0n;
  const ownerGas = normalizeSuiAddress(tx.gasOwner) === owner ? tx.gasPaidMist : 0n;
  /** SUI that moved between the owner's wallet and SuiLend, gas excluded (+ = credited). */
  const walletFlow = ownerChange + ownerGas;

  const [market, obligations] = await Promise.all([port.readMarket(), port.readObligations(owner)]);
  const common = { digest: rec.digest, signer: tx.sender, gasPaidByOwnerSui: formatMist(ownerGas < 0n ? 0n : ownerGas) };

  if (rec.action === "supply") {
    const amount = BigInt(ctx.amountMist!);
    const expected = BigInt(ctx.expectedCtokens!);
    let target: ObligationSnapshot | undefined;
    if (ctx.obligationId) target = obligations.find((o) => sameId(o.obligationId, ctx.obligationId!));
    else {
      const created = obligations.filter((o) => !ctx.obligationIdsBefore.some((id) => sameId(id, o.obligationId)));
      if (created.length > 1) return { state: "mismatch", reason: `expected one new obligation, found ${created.length}` };
      target = created[0];
    }
    if (!target) return { state: "not_yet", reason: "the supplied obligation and its owner cap are not visible for the owner yet" };
    const before = ctx.obligationId ? BigInt(ctx.ctokensBefore ?? "0") : 0n;
    const added = target.suiCtokens - before;
    if (added === 0n) return { state: "not_yet", reason: "the obligation does not show the new deposit yet" };
    // Interest accrued between plan and execution only lowers the cTokens minted.
    if (added < 0n || added > expected || added * 100n < expected * 99n) {
      return { state: "mismatch", reason: `obligation cTokens changed by ${added}, expected ≈ ${expected}` };
    }
    if (target.borrowCount > 0) return { state: "mismatch", reason: `obligation ${target.obligationId} now has borrows` };
    if (-walletFlow !== amount) {
      return { state: "mismatch", reason: `owner's wallet moved ${formatMist(-walletFlow)} SUI into the transaction, planned ${formatMist(amount)}` };
    }
    return {
      state: "reconciled",
      report: { ...common, suppliedSui: formatMist(amount), position: { ...positionView(target, market), suiCtokensAdded: added.toString() } },
    };
  }

  const target = obligations.find((o) => sameId(o.obligationId, ctx.obligationId!));
  // Same as supply: an owner-cap index lagging behind is "not yet", never success.
  if (!target) return { state: "not_yet", reason: `obligation ${ctx.obligationId} is not visible for the owner (read-node lag, or owner cap moved)` };
  const removed = BigInt(ctx.ctokensBefore!) - target.suiCtokens;
  if (removed === 0n) return { state: "not_yet", reason: "the obligation does not show the withdrawal yet" };
  if (removed < 0n || (!ctx.withdrawAll && removed !== BigInt(ctx.withdrawCtokens!))) {
    return { state: "mismatch", reason: `obligation cTokens changed by ${-removed}, planned −${ctx.withdrawCtokens ?? "max"}` };
  }
  if (target.borrowCount > 0) return { state: "mismatch", reason: `obligation ${target.obligationId} now has borrows` };
  if (walletFlow <= 0n || (!ctx.withdrawAll && walletFlow < BigInt(ctx.estimatedMist!))) {
    return { state: "mismatch", reason: `owner's wallet was credited ${formatMist(walletFlow < 0n ? 0n : walletFlow)} SUI, expected ≥ ${formatMist(BigInt(ctx.estimatedMist ?? "1"))}` };
  }
  return {
    state: "reconciled",
    report: { ...common, walletCreditSui: formatMist(walletFlow), ctokensWithdrawn: removed.toString(), residual: positionView(target, market) },
  };
}

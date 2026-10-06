import type { Transaction, TransactionObjectInput, TransactionResult } from "@mysten/sui/transactions";
import { SUI_COIN_TYPE } from "./constants.js";
import type { SupplyPlan, WithdrawPlan } from "./plan.js";

/** The subset of `SuilendClient` (@suilend/sdk 13.0.0) this recipe calls. Nothing borrow-related. */
export interface SuilendCalls {
  createObligation(tx: Transaction): TransactionResult;
  deposit(coin: TransactionObjectInput, coinType: string, cap: TransactionObjectInput, tx: Transaction): void;
  withdraw(
    cap: TransactionObjectInput,
    obligationId: string,
    coinType: string,
    value: string,
    tx: Transaction,
    addRefreshCalls?: boolean,
  ): Promise<TransactionResult>;
}

/**
 * Supply: split exactly `amountMist` from the GasCoin (the same pattern waap-cli uses for
 * its own SUI transfers), mint cTokens and deposit them into the obligation. A first supply
 * creates the obligation and hands its owner cap to the owner in the same transaction.
 */
/**
 * Follow-up 3: one effect-free command carrying this submission's random nonce, so its kind bytes
 * (and so its kind hash) are unique to it. `vector<vector<u8>>` has `drop`; the result is unused.
 */
export function addSubmissionNonce(tx: Transaction, nonce: Uint8Array): void {
  tx.makeMoveVec({ type: "vector<u8>", elements: [tx.pure.vector("u8", Array.from(nonce))] });
}

export function addSupplyCommands(tx: Transaction, suilend: SuilendCalls, plan: SupplyPlan, nonce?: Uint8Array): void {
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(plan.amountMist)]);
  if (plan.obligation.kind === "new") {
    const cap = suilend.createObligation(tx);
    suilend.deposit(coin, SUI_COIN_TYPE, cap, tx);
    tx.transferObjects([cap], tx.pure.address(plan.owner));
  } else {
    suilend.deposit(coin, SUI_COIN_TYPE, tx.object(plan.obligation.capId), tx);
  }
  if (nonce) addSubmissionNonce(tx, nonce);
}

/**
 * Withdraw: withdraw cTokens from the obligation, redeem them for SUI and send the SUI to the
 * owner. No price-refresh calls: with no borrows SuiLend accepts stale oracles for withdraw
 * (obligation::withdraw, source d5ba83a) and the planner refuses obligations with borrows.
 */
export async function addWithdrawCommands(tx: Transaction, suilend: SuilendCalls, plan: WithdrawPlan, nonce?: Uint8Array): Promise<void> {
  const [coin] = await suilend.withdraw(
    tx.object(plan.capId),
    plan.obligationId,
    SUI_COIN_TYPE,
    plan.ctokens.toString(),
    tx,
    false,
  );
  tx.transferObjects([coin], tx.pure.address(plan.owner));
  if (nonce) addSubmissionNonce(tx, nonce);
}

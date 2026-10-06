import { describe, expect, it } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { addSupplyCommands, addWithdrawCommands } from "../src/ptb.js";
import { inspectKind } from "../src/inspect.js";
import { planSupply, planWithdraw } from "../src/plan.js";
import { U64_MAX } from "../src/constants.js";
import { CAP_A, MIST, OWNER, buildKindOffline, market, obligation, stubSuilend, wallet } from "./helpers.js";

const m = market();
const supplyNew = () => planSupply({ amountMist: 3n * MIST, gasReserveMist: MIST / 20n, wallet: wallet(10n * MIST), market: m, obligations: [] });
const supplyExisting = () =>
  planSupply({ amountMist: 1_500_000_000n, gasReserveMist: MIST / 20n, wallet: wallet(10n * MIST), market: m, obligations: [obligation()] });
const withdrawSome = () => planWithdraw({ amountMist: 2n * MIST, wallet: wallet(MIST), market: m, obligations: [obligation()] });
const withdrawAll = () => planWithdraw({ all: true, wallet: wallet(MIST), market: m, obligations: [obligation()] });

const commands = (kind: Uint8Array) => Transaction.fromKind(kind).getData();

describe("supply PTB (real SDK builders, offline resolver)", () => {
  it("first supply: split from GasCoin, create obligation, deposit, return cap to owner", async () => {
    const plan = supplyNew();
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan));
    const summary = inspectKind(kind, plan, m);
    expect(summary.calls).toEqual([
      "SplitCoins(GasCoin)",
      "lending_market::create_obligation",
      "lending_market::deposit_liquidity_and_mint_ctokens",
      "lending_market::deposit_ctokens_into_obligation",
      "lending_market::rebalance_staker",
      "TransferObjects(owner)",
    ]);
    const data = commands(kind);
    expect(data.inputs.some((i: any) => i.$kind === "FundsWithdrawal")).toBe(false);
    expect(data.sender ?? null).toBeNull(); // kind bytes carry no sender/gas; WaaP prepares those
    // the reserve index used is the SUI reserve's (2), not the SDK's silent -1
    const deposit = data.commands[2].MoveCall!;
    const idxArg = deposit.arguments[1] as any;
    expect(BigInt(bcs.u64().parse(Uint8Array.from(Buffer.from((data.inputs[idxArg.Input] as any).Pure.bytes, "base64"))))).toBe(2n);
  });

  it("supply to an existing obligation uses its cap and transfers nothing", async () => {
    const plan = supplyExisting();
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan));
    const summary = inspectKind(kind, plan, m);
    expect(summary.calls).not.toContain("lending_market::create_obligation");
    expect(summary.calls).not.toContain("TransferObjects(owner)");
    const owned = commands(kind).inputs.filter((i: any) => i.Object?.ImmOrOwnedObject);
    expect(owned.map((i: any) => i.Object.ImmOrOwnedObject.objectId)).toEqual([CAP_A]);
  });

  it("shared objects have the mutability of the Move signatures", async () => {
    const plan = supplyNew();
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan));
    const shared = Object.fromEntries(
      commands(kind)
        .inputs.filter((i: any) => i.Object?.SharedObject)
        .map((i: any) => [normalizeSuiAddress(i.Object.SharedObject.objectId), i.Object.SharedObject.mutable]),
    );
    expect(shared[normalizeSuiAddress("0x6")]).toBe(false);
    expect(shared[normalizeSuiAddress("0x5")]).toBe(true);
    expect(Object.values(shared).filter((v) => v === true)).toHaveLength(2);
  });
});

describe("withdraw PTB", () => {
  it("withdraws exactly the planned cTokens, no price refresh, SUI to owner", async () => {
    const plan = withdrawSome();
    const kind = await buildKindOffline((tx) => addWithdrawCommands(tx, stubSuilend(), plan));
    const summary = inspectKind(kind, plan, m);
    expect(summary.calls).toEqual([
      "lending_market::withdraw_ctokens",
      "0x1::option::none",
      "lending_market::redeem_ctokens_and_withdraw_liquidity_request",
      "lending_market::unstake_sui_from_staker",
      "lending_market::fulfill_liquidity_request",
      "TransferObjects(owner)",
    ]);
    expect(summary.calls.join()).not.toMatch(/refresh|pyth|borrow/);
    expect(plan.ctokens).toBe(1_904_761_904n); // floor(2 SUI / 1.05)
  });

  it("--all passes U64_MAX", async () => {
    const plan = withdrawAll();
    expect(plan.ctokens).toBe(U64_MAX);
    const kind = await buildKindOffline((tx) => addWithdrawCommands(tx, stubSuilend(), plan));
    expect(() => inspectKind(kind, plan, m)).not.toThrow();
  });
});

describe("inspectKind rejects tampered or unexpected transactions", () => {
  const SUI = "0x2::sui::SUI";
  const tamper = async (plan: any, extra: (tx: Transaction, s: any) => void | Promise<void>, base = true) =>
    buildKindOffline(async (tx) => {
      const s = stubSuilend();
      if (base) {
        if (plan.action === "supply") addSupplyCommands(tx, s, plan);
        else await addWithdrawCommands(tx, s, plan);
      }
      await extra(tx, s);
    });

  it("a borrow call", async () => {
    const plan = supplyExisting();
    const kind = await tamper(plan, (tx, s) => {
      tx.moveCall({
        target: `${m.publishedAt}::lending_market::borrow_request`,
        typeArguments: [m.lendingMarketType, SUI],
        arguments: [tx.object(m.lendingMarketId), tx.pure.u64(2n), tx.object(CAP_A), tx.object("0x6"), tx.pure.u64(1n)],
      });
    });
    expect(() => inspectKind(kind, plan, m)).toThrow(/borrow_request is not allowed/);
  });

  it("withdrawn SUI sent to someone else", async () => {
    const plan = withdrawSome();
    const kind = await buildKindOffline((tx) => addWithdrawCommands(tx, stubSuilend(), { ...plan, owner: "0x" + "66".repeat(32) }));
    expect(() => inspectKind(kind, plan, m)).toThrow(/recipient .* is not the owner/);
  });

  it("new obligation cap sent to someone else", async () => {
    const plan = supplyNew();
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), { ...plan, owner: "0x" + "66".repeat(32) }));
    expect(() => inspectKind(kind, plan, m)).toThrow(/recipient .* is not the owner/);
  });

  it("an extra coin split in a withdraw", async () => {
    const plan = withdrawSome();
    const kind = await tamper(plan, (tx) => {
      tx.splitCoins(tx.gas, [1n]);
    });
    expect(() => inspectKind(kind, plan, m)).toThrow(/SplitCoins in a withdraw/);
  });

  it("a different split amount than planned", async () => {
    const plan = supplyExisting();
    const kind = await tamper(plan, (tx, s) => {
      const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(plan.amountMist + 1n)]);
      s.deposit(c, SUI, tx.object(CAP_A), tx);
    }, false);
    expect(() => inspectKind(kind, plan, m)).toThrow(/split amount/);
  });

  it("a different withdraw amount than planned", async () => {
    const plan = withdrawSome();
    const other = { ...plan, ctokens: plan.ctokens + 1n };
    const kind = await buildKindOffline((tx) => addWithdrawCommands(tx, stubSuilend(), other));
    expect(() => inspectKind(kind, plan, m)).toThrow(/withdraw_ctokens amount/);
  });

  it("a different package than the published-at in effect", async () => {
    const plan = supplyExisting();
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan));
    expect(() => inspectKind(kind, plan, { ...m, publishedAt: "0x" + "99".repeat(32) })).toThrow(/expected SuiLend/);
  });

  it("a non-SUI coin type", async () => {
    const plan = supplyExisting();
    const kind = await tamper(plan, (tx, s) => {
      const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(plan.amountMist)]);
      s.deposit(c, "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", tx.object(CAP_A), tx);
    }, false);
    expect(() => inspectKind(kind, plan, m)).toThrow(/non-SUI coin type/);
  });

  it("an address-balance FundsWithdrawal input (what getSpendableCoin can emit)", async () => {
    const plan = supplyExisting();
    const kind = await tamper(plan, (tx) => {
      tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [SUI], arguments: [tx.withdrawal({ amount: 1n, type: SUI })] });
    });
    expect(() => inspectKind(kind, plan, m)).toThrow(/FundsWithdrawal|not allowed|package/);
  });

  it("an owned object other than the obligation cap", async () => {
    const plan = supplyNew(); // new obligation: no owned objects expected at all
    const kind = await tamper(plan, (tx) => {
      tx.transferObjects([tx.object(CAP_A)], OWNER);
    });
    expect(() => inspectKind(kind, plan, m)).toThrow(/unexpected owned object/);
  });
});

// Follow-up 3: the submission nonce.
describe("inspectKind: submission nonce", () => {
  const plan = planSupply({ amountMist: 2n * MIST, gasReserveMist: MIST / 10n, wallet: wallet(10n * MIST), market: m, obligations: [obligation()] });
  const n1 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const n2 = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);

  it("accepts exactly the planned nonce, as one effect-free MakeMoveVec", async () => {
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan, n1));
    expect(inspectKind(kind, plan, m, n1).calls).toContain("MakeMoveVec(nonce)");
  });
  it("rejects a different nonce", async () => {
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan, n2));
    expect(() => inspectKind(kind, plan, m, n1)).toThrow(/nonce differs/);
  });
  it("rejects a missing nonce when one is planned", async () => {
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan));
    expect(() => inspectKind(kind, plan, m, n1)).toThrow(/exactly one submission nonce/);
  });
  it("rejects a second MakeMoveVec", async () => {
    const kind = await buildKindOffline((tx) => {
      addSupplyCommands(tx, stubSuilend(), plan, n1);
      tx.makeMoveVec({ type: "vector<u8>", elements: [tx.pure.vector("u8", Array.from(n1))] });
    });
    expect(() => inspectKind(kind, plan, m, n1)).toThrow(/exactly one submission nonce/);
  });
  it("rejects any MakeMoveVec when no nonce is planned", async () => {
    const kind = await buildKindOffline((tx) => addSupplyCommands(tx, stubSuilend(), plan, n1));
    expect(() => inspectKind(kind, plan, m)).toThrow(/without a planned submission nonce/);
  });
});

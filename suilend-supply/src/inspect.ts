import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import { ALLOWED_SUILEND_CALLS, SUI_COIN_TYPE } from "./constants.js";
import { RecipeError } from "./errors.js";
import type { SupplyPlan, WithdrawPlan } from "./plan.js";
import type { MarketSnapshot } from "./types.js";

const CLOCK = normalizeSuiObjectId("0x6");
const SYSTEM_STATE = normalizeSuiObjectId("0x5");
const STD = normalizeSuiAddress("0x1");

export interface KindSummary {
  calls: string[];
  commandCount: number;
}

type Arg = { $kind: string; Input?: number; Result?: number; NestedResult?: [number, number]; GasCoin?: true };

function fail(msg: string): never {
  throw new RecipeError("PREFLIGHT_REFUSED", `Transaction failed safety inspection: ${msg}`);
}

/**
 * Decode kind bytes exactly as they will be handed to waap-cli and check them against the plan.
 * This is the last line of defence against a builder or SDK change producing something else.
 */
export function inspectKind(kind: Uint8Array, plan: SupplyPlan | WithdrawPlan, market: MarketSnapshot, nonce?: Uint8Array): KindSummary {
  const data = Transaction.fromKind(kind).getData();
  const inputs = data.inputs as any[];
  const owner = normalizeSuiAddress(plan.owner);
  const pkg = normalizeSuiAddress(market.publishedAt);
  const poolType = normalizeStructTag(market.lendingMarketType);
  const marketId = normalizeSuiObjectId(market.lendingMarketId);
  const expectedCap = plan.action === "withdraw" ? plan.capId : plan.obligation.kind === "existing" ? plan.obligation.capId : undefined;

  const pureInput = (arg: Arg) => {
    if (arg.$kind !== "Input") fail("expected a pure input argument");
    const input = inputs[arg.Input!];
    if (input?.$kind !== "Pure") fail(`input ${arg.Input} is not a pure value`);
    return Uint8Array.from(Buffer.from(input.Pure.bytes, "base64"));
  };

  inputs.forEach((input, i) => {
    switch (input.$kind) {
      case "Pure":
        return;
      case "Object": {
        const o = input.Object;
        if (o.SharedObject) {
          const id = normalizeSuiObjectId(o.SharedObject.objectId);
          if (![marketId, CLOCK, SYSTEM_STATE].includes(id)) fail(`unexpected shared object ${id}`);
          return;
        }
        if (o.ImmOrOwnedObject) {
          const id = normalizeSuiObjectId(o.ImmOrOwnedObject.objectId);
          if (!expectedCap || id !== normalizeSuiObjectId(expectedCap)) fail(`unexpected owned object ${id}`);
          return;
        }
        return fail(`unsupported object input kind at ${i}`);
      }
      default:
        // FundsWithdrawal (address balances), Receiving, unresolved inputs: none are expected.
        return fail(`unsupported input kind ${input.$kind} at ${i}`);
    }
  });

  const calls: string[] = [];
  let splits = 0;
  let transfers = 0;
  let createResult: number | undefined;
  let nonces = 0;

  data.commands.forEach((cmd: any, idx: number) => {
    switch (cmd.$kind) {
      case "MoveCall": {
        const mc = cmd.MoveCall;
        const callPkg = normalizeSuiAddress(mc.package);
        const name = `${mc.module}::${mc.function}`;
        if (callPkg === STD && name === "option::none" && mc.arguments.length === 0) {
          calls.push("0x1::option::none");
          return;
        }
        if (callPkg !== pkg) fail(`move call to package ${callPkg}, expected SuiLend ${pkg}`);
        if (!ALLOWED_SUILEND_CALLS.has(name)) fail(`move call ${name} is not allowed`);
        const types = (mc.typeArguments as string[]).map((t) => normalizeStructTag(t));
        if (types[0] !== poolType) fail(`${name} is not for the SuiLend main pool`);
        if (types.slice(1).some((t) => t !== SUI_COIN_TYPE)) fail(`${name} uses a non-SUI coin type`);
        if (name === "lending_market::create_obligation") {
          if (plan.action !== "supply" || plan.obligation.kind !== "new") fail("unexpected create_obligation");
          createResult = idx;
        }
        if (name === "lending_market::withdraw_ctokens") {
          if (plan.action !== "withdraw") fail("withdraw_ctokens in a supply transaction");
          const amountArg = mc.arguments[4] as Arg;
          const ctokens = BigInt(bcs.u64().parse(pureInput(amountArg)));
          if (ctokens !== plan.ctokens) fail(`withdraw_ctokens amount ${ctokens} ≠ planned ${plan.ctokens}`);
        }
        calls.push(name);
        return;
      }
      case "SplitCoins": {
        splits++;
        if (plan.action !== "supply") fail("SplitCoins in a withdraw transaction");
        if (cmd.SplitCoins.coin.$kind !== "GasCoin") fail("supply coin is not split from the GasCoin");
        if (cmd.SplitCoins.amounts.length !== 1) fail("SplitCoins must have exactly one amount");
        const amount = BigInt(bcs.u64().parse(pureInput(cmd.SplitCoins.amounts[0])));
        if (amount !== plan.amountMist) fail(`split amount ${amount} ≠ planned ${plan.amountMist}`);
        calls.push("SplitCoins(GasCoin)");
        return;
      }
      case "TransferObjects": {
        transfers++;
        const to = normalizeSuiAddress(bcs.Address.parse(pureInput(cmd.TransferObjects.address)));
        if (to !== owner) fail(`TransferObjects recipient ${to} is not the owner ${owner}`);
        calls.push("TransferObjects(owner)");
        return;
      }
      case "MakeMoveVec": {
        // Follow-up 3: only the submission nonce, exactly as planned.
        const mv = cmd.MakeMoveVec;
        if (!nonce) fail("MakeMoveVec is not allowed without a planned submission nonce");
        if (mv.type !== "vector<u8>" || mv.elements.length !== 1) fail("MakeMoveVec is not the submission nonce");
        const got = bcs.vector(bcs.u8()).parse(pureInput(mv.elements[0]));
        if (Buffer.compare(Buffer.from(got), Buffer.from(nonce)) !== 0) fail("submission nonce differs from the planned one");
        nonces++;
        calls.push("MakeMoveVec(nonce)");
        return;
      }
      default:
        fail(`command kind ${cmd.$kind} is not allowed`);
    }
  });

  if (nonce && nonces !== 1) fail(`expected exactly one submission nonce, found ${nonces}`);
  if (plan.action === "supply") {
    if (splits !== 1) fail("supply must split exactly one coin");
    for (const c of ["lending_market::deposit_liquidity_and_mint_ctokens", "lending_market::deposit_ctokens_into_obligation"]) {
      if (!calls.includes(c)) fail(`missing ${c}`);
    }
    if (plan.obligation.kind === "new") {
      if (createResult === undefined || transfers !== 1) fail("new obligation cap must be transferred to the owner");
      const t = data.commands.find((c: any) => c.$kind === "TransferObjects") as any;
      const objs = t.TransferObjects.objects as Arg[];
      if (!objs.some((a) => (a.Result ?? a.NestedResult?.[0]) === createResult)) fail("obligation cap is not transferred");
    } else if (transfers !== 0) fail("unexpected transfer in supply to existing obligation");
  } else {
    if (!calls.includes("lending_market::withdraw_ctokens") || !calls.includes("lending_market::fulfill_liquidity_request")) {
      fail("withdraw transaction is incomplete");
    }
    if (transfers !== 1) fail("withdrawn SUI must be transferred to the owner exactly once");
  }
  return { calls, commandCount: data.commands.length };
}

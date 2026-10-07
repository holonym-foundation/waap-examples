import { afterAll, describe, expect, it } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { setPublishedAt } from "@suilend/sdk/_generated/suilend";
import { getPublishedAt } from "@suilend/sdk/_generated/_framework/env";
import { explainExecutionError, mapObligations, typeNameToString } from "../src/chain.js";
import { SUI_COIN_TYPE } from "../src/constants.js";
import { CAP_A, CAP_B, OBL_A, OBL_B, stubSuilend } from "./helpers.js";

const LONG_SUI = "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

describe("typeNameToString", () => {
  it.each([["0x2::sui::SUI"], [LONG_SUI], ["0x" + LONG_SUI], [{ name: LONG_SUI }]])("%j → SUI", (t) =>
    expect(typeNameToString(t)).toBe(SUI_COIN_TYPE));
  it("keeps other types distinct", () =>
    expect(typeNameToString({ name: "dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" })).not.toBe(SUI_COIN_TYPE));
});

describe("mapObligations", () => {
  const dep = (coinType: unknown, n: bigint) => ({ coinType, depositedCtokenAmount: n });
  it("pairs caps by normalized id regardless of order or 0x/padding form", () => {
    const caps = [
      { id: CAP_B, obligationId: OBL_B.toUpperCase().replace("0X", "0x") },
      { id: CAP_A, obligationId: OBL_A },
    ];
    const res = mapObligations(caps, [
      { id: OBL_A, deposits: [dep({ name: LONG_SUI }, 5n), dep({ name: "dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" }, 7n)], borrows: [] },
      { id: OBL_B, deposits: [], borrows: [{}] },
    ]);
    expect(res[0]).toMatchObject({ capId: CAP_A, suiCtokens: 5n, depositCount: 2, borrowCount: 0 });
    expect(res[0].otherDeposits).toHaveLength(1);
    expect(res[1]).toMatchObject({ capId: CAP_B, suiCtokens: 0n, borrowCount: 1 });
  });
  it("missing cap is an error, not a silent zero", () =>
    expect(() => mapObligations([], [{ id: OBL_A, deposits: [], borrows: [] }])).toThrow(/No owner cap/));
});

describe("published-at is a single source for builders and inspector", () => {
  const original = getPublishedAt("suilend");
  afterAll(() => setPublishedAt(original));
  it("setPublishedAt changes both getPublishedAt and the SDK's move-call targets", () => {
    const dummy = "0x" + "d0".repeat(32);
    setPublishedAt(dummy);
    expect(getPublishedAt("suilend")).toBe(dummy);
    const tx = new Transaction();
    stubSuilend().createObligation(tx);
    expect((tx.getData().commands[0] as any).MoveCall.package).toBe(dummy);
  });
});

describe("explainExecutionError", () => {
  it.each([
    ["rate_limiter", "2", /rate limit/],
    ["reserve", "2", /deposit limit/],
    ["reserve", "5", /liquidity/],
    ["lending_market", "1", /version mismatch/],
    ["obligation", "5", /too many deposit/],
  ])("%s abort %s", (module, code, re) =>
    expect(explainExecutionError({ message: "x", MoveAbort: { abortCode: code, location: { module } } }).reason).toMatch(re));
  it("unknown abort and non-abort errors", () => {
    expect(explainExecutionError({ MoveAbort: { abortCode: "77", location: { module: "foo" } } })).toMatchObject({ reason: "Move abort 77 in foo", abort: { module: "foo", code: "77" } });
    expect(explainExecutionError({ message: "InsufficientGas" }).reason).toBe("InsufficientGas");
    expect(explainExecutionError(undefined).reason).toBe("simulation failed");
  });
});

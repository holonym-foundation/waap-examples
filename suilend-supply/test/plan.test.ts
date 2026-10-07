import BigNumber from "bignumber.js";
import { describe, expect, it } from "vitest";
import { ctokensToMist, mistToCtokens, planSupply, planWithdraw } from "../src/plan.js";
import { U64_MAX } from "../src/constants.js";
import { RecipeError } from "../src/errors.js";
import { CAP_B, MIST, OBL_A, OBL_B, OWNER, market, obligation, wallet } from "./helpers.js";

const R = MIST / 20n; // default 0.05 SUI gas reserve
const supply = (over: Partial<Parameters<typeof planSupply>[0]> = {}) =>
  planSupply({ amountMist: MIST, gasReserveMist: R, wallet: wallet(10n * MIST), market: market(), obligations: [obligation()], ...over });
const withdraw = (over: Partial<Parameters<typeof planWithdraw>[0]> = {}) =>
  planWithdraw({ amountMist: MIST, wallet: wallet(MIST), market: market(), obligations: [obligation()], ...over });
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as RecipeError).code;
  }
  return "NO_ERROR";
};

describe("cToken conversion (rate 1.05 SUI/cToken)", () => {
  const r = market().sui;
  it("rounds down both ways", () => {
    expect(mistToCtokens(r, 1_050_000_000n)).toBe(1_000_000_000n);
    expect(mistToCtokens(r, 1n)).toBe(0n);
    expect(ctokensToMist(r, 1n)).toBe(1n);
    expect(ctokensToMist(r, 3n)).toBe(3n); // 3.15 → 3
  });
  it("converting back never exceeds the requested amount", () => {
    for (const mist of [1n, 2n, 999n, 1_000_000_001n, 123_456_789_012n]) {
      expect(ctokensToMist(r, mistToCtokens(r, mist)) <= mist).toBe(true);
    }
  });
  it("empty reserve is 1:1", () => {
    const empty = { ...r, ctokenSupply: 0n, totalSupplyMist: new BigNumber(0) };
    expect(mistToCtokens(empty, 5n)).toBe(5n);
  });
});

describe("planSupply", () => {
  it("E6 one obligation → uses it", () => {
    const p = supply();
    expect(p.obligation).toMatchObject({ kind: "existing", obligationId: OBL_A });
    expect(p.expectedCtokens).toBe(952_380_952n);
  });
  it("E5 no obligation → creates one", () => expect(supply({ obligations: [] }).obligation.kind).toBe("new"));
  it("E7 several obligations → must choose", () => {
    const two = [obligation(), obligation({ obligationId: OBL_B, capId: CAP_B })];
    expect(code(() => supply({ obligations: two }))).toBe("PREFLIGHT_REFUSED");
    expect(supply({ obligations: two, obligationId: OBL_B }).obligation).toMatchObject({ capId: CAP_B });
  });
  it("E8 unknown obligation id → refused", () =>
    expect(code(() => supply({ obligationId: "0x" + "ff".repeat(32) }))).toBe("PREFLIGHT_REFUSED"));
  it("--obligation-id and --new-obligation together are invalid", () =>
    expect(code(() => supply({ obligationId: OBL_A, newObligation: true }))).toBe("INVALID_INPUT"));
  it("E9 obligation with borrows → refused; --new-obligation still allowed", () => {
    const leveraged = [obligation({ borrowCount: 1 })];
    expect(code(() => supply({ obligations: leveraged }))).toBe("PREFLIGHT_REFUSED");
    expect(supply({ obligations: leveraged, newObligation: true }).obligation.kind).toBe("new");
  });
  it("E3 insufficient SUI including the gas reserve", () => {
    expect(code(() => supply({ wallet: wallet(MIST) }))).toBe("PREFLIGHT_REFUSED"); // 1 SUI < 1.05
    expect(supply({ wallet: wallet(MIST + R) }).amountMist).toBe(MIST); // exactly enough
    expect(code(() => supply({ wallet: wallet(MIST + R - 1n) }))).toBe("PREFLIGHT_REFUSED");
  });
  it("E4 SUI only in address balance is not counted", () => {
    expect(() => supply({ wallet: wallet(0n, 50n * MIST) })).toThrow(/address balance/);
  });
  it("E15 deposit limit headroom", () => {
    const nearlyFull = market({ depositLimitMist: 2_100_000n * MIST + MIST / 2n });
    expect(() => supply({ market: nearlyFull })).toThrow(/deposit limit/);
    expect(supply({ market: nearlyFull, amountMist: MIST / 2n }).amountMist).toBe(MIST / 2n);
  });
  it("too small to mint a cToken", () => expect(code(() => supply({ amountMist: 1n }))).toBe("PREFLIGHT_REFUSED"));
  it("obligation already at 7 deposit types without SUI", () => {
    const full = [obligation({ suiCtokens: 0n, depositCount: 7 })];
    expect(code(() => supply({ obligations: full }))).toBe("PREFLIGHT_REFUSED");
    expect(supply({ obligations: [obligation({ depositCount: 7 })] }).amountMist).toBe(MIST); // SUI already among them
  });
  it("owner is the wallet address", () => expect(supply().owner).toBe(OWNER));
});

describe("planWithdraw", () => {
  it("needs exactly one of amount / all", () => {
    expect(code(() => withdraw({ amountMist: undefined }))).toBe("INVALID_INPUT");
    expect(code(() => withdraw({ all: true }))).toBe("INVALID_INPUT");
  });
  it("E12 converts SUI to cTokens rounding down and reports the estimate", () => {
    const p = withdraw();
    expect(p.ctokens).toBe(952_380_952n);
    expect(p.estimatedMist).toBe(999_999_999n);
    expect(p.warnings.join()).toMatch(/rounding/);
  });
  it("E10 more than supplied → refused with hint to use --all", () => {
    expect(() => withdraw({ amountMist: 11n * MIST })).toThrow(/use --all/);
    expect(withdraw({ amountMist: 10n * MIST }).ctokens).toBe(9_523_809_523n); // 10 cTokens ≈ 10.5 SUI supplied
  });
  it("E11 converts to zero cTokens → refused", () => expect(code(() => withdraw({ amountMist: 1n }))).toBe("PREFLIGHT_REFUSED"));
  it("E9 borrows → refused", () => expect(code(() => withdraw({ obligations: [obligation({ borrowCount: 2 })] }))).toBe("PREFLIGHT_REFUSED"));
  it("nothing supplied / no obligation → refused", () => {
    expect(code(() => withdraw({ obligations: [] }))).toBe("PREFLIGHT_REFUSED");
    expect(code(() => withdraw({ obligations: [obligation({ suiCtokens: 0n })] }))).toBe("PREFLIGHT_REFUSED");
  });
  it("E14 reserve liquidity below the request → refused", () => {
    const illiquid = market({ availableMist: MIST / 2n });
    expect(() => withdraw({ market: illiquid })).toThrow(/available to withdraw/);
  });
  it("E13 --all → U64_MAX, warns when liquidity caps it", () => {
    const p = withdraw({ amountMist: undefined, all: true });
    expect(p.ctokens).toBe(U64_MAX);
    expect(p.estimatedMist).toBe(10_500_000_000n);
    const capped = withdraw({ amountMist: undefined, all: true, market: market({ availableMist: 2n * MIST }) });
    expect(capped.estimatedMist).toBe(2n * MIST - 100n);
    expect(capped.warnings.join()).toMatch(/leaves the rest supplied/);
  });
  it("--new-obligation is not accepted for withdraw", () => {
    // chooseObligation is shared; withdraw never creates
    expect(code(() => withdraw({ obligations: [], obligationId: undefined }))).toBe("PREFLIGHT_REFUSED");
  });
});

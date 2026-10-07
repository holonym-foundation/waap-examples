import { describe, expect, it } from "vitest";
import { formatMist, parseSuiAmount } from "../src/amount.js";

describe("parseSuiAmount", () => {
  it.each([
    ["1", 1_000_000_000n],
    ["0.5", 500_000_000n],
    ["0.000000001", 1n],
    ["12.000000001", 12_000_000_001n],
    ["007", 7_000_000_000n],
    ["18446744073.709551615", 18_446_744_073_709_551_615n],
  ])("%s → %s MIST exactly", (input, mist) => expect(parseSuiAmount(input)).toBe(mist));

  it.each([
    undefined, "", "0", "0.0", "-1", "+1", "1e3", "1E-9", ".5", "5.", "0.0000000001", " 1", "1 ", "1,5", "1_000",
    "max", "all", "NaN", "Infinity", "0x10", "١", "18446744073.709551616",
  ])("rejects %j", (input) => expect(() => parseSuiAmount(input as any)).toThrow());

  it("never goes through floating point", () => {
    expect(parseSuiAmount("0.3")).toBe(300_000_000n);
    expect(parseSuiAmount("1.1")).toBe(1_100_000_000n);
  });
});

describe("formatMist", () => {
  it.each([
    [1n, "0.000000001"],
    [1_500_000_000n, "1.5"],
    [0n, "0"],
    [-2_000_000_000n, "-2"],
  ])("%s → %s", (mist, s) => expect(formatMist(mist)).toBe(s));
  it("round-trips", () => {
    for (const s of ["1", "0.5", "123.456789012"]) expect(formatMist(parseSuiAmount(s))).toBe(s);
  });
});

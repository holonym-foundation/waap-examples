import { MIST_PER_SUI, U64_MAX } from "./constants.js";
import { RecipeError } from "./errors.js";

const DECIMAL = /^(\d+)(?:\.(\d{1,9}))?$/;

/**
 * Parse a user-supplied SUI amount ("1", "0.5", "12.000000001") into MIST exactly.
 * Rejects anything that is not a plain positive decimal with at most 9 fraction digits:
 * no signs, exponents, separators, whitespace or "max".
 */
export function parseSuiAmount(input: unknown): bigint {
  if (typeof input !== "string" || input.length === 0) {
    throw new RecipeError("INVALID_INPUT", "An explicit SUI amount is required, e.g. --amount 1.5");
  }
  const m = DECIMAL.exec(input);
  if (!m) {
    throw new RecipeError(
      "INVALID_INPUT",
      `Invalid SUI amount "${input}": use a plain decimal with at most 9 decimal places (e.g. 0.25)`,
    );
  }
  const mist = BigInt(m[1]) * MIST_PER_SUI + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  if (mist === 0n) throw new RecipeError("INVALID_INPUT", "Amount must be greater than zero");
  if (mist > U64_MAX) throw new RecipeError("INVALID_INPUT", `Amount "${input}" exceeds u64`);
  return mist;
}

export function formatMist(mist: bigint): string {
  const neg = mist < 0n;
  const abs = neg ? -mist : mist;
  const whole = abs / MIST_PER_SUI;
  const frac = (abs % MIST_PER_SUI).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

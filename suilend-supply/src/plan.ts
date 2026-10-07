import BigNumber from "bignumber.js";
import { formatMist } from "./amount.js";
import { U64_MAX } from "./constants.js";
import { RecipeError } from "./errors.js";
import type { MarketSnapshot, ObligationSnapshot, SuiReserveSnapshot, WalletSnapshot } from "./types.js";

/** Mirrors obligation.move MAX_DEPOSITS and reserve.move MIN_AVAILABLE_AMOUNT (source d5ba83a). */
const MAX_DEPOSITS = 7;
const MIN_AVAILABLE_AMOUNT = 100n;

export type ObligationChoice =
  | { kind: "new" }
  | { kind: "existing"; obligationId: string; capId: string; obligation: ObligationSnapshot };

export interface SupplyPlan {
  action: "supply";
  owner: string;
  amountMist: bigint;
  obligation: ObligationChoice;
  expectedCtokens: bigint;
  warnings: string[];
}

export interface WithdrawPlan {
  action: "withdraw";
  owner: string;
  obligationId: string;
  capId: string;
  /** cTokens passed to withdraw_ctokens; U64_MAX means "maximum allowed". */
  ctokens: bigint;
  all: boolean;
  estimatedMist: bigint;
  warnings: string[];
}

const refuse = (message: string, details?: Record<string, unknown>) =>
  new RecipeError("PREFLIGHT_REFUSED", message, details);

/** cTokens → MIST, rounded down like reserve::redeem_ctokens. */
export function ctokensToMist(reserve: SuiReserveSnapshot, ctokens: bigint): bigint {
  if (reserve.ctokenSupply === 0n) return ctokens;
  return BigInt(
    new BigNumber(ctokens.toString())
      .times(reserve.totalSupplyMist)
      .div(reserve.ctokenSupply.toString())
      .integerValue(BigNumber.ROUND_FLOOR)
      .toFixed(0),
  );
}

/** MIST → cTokens, rounded down (so the user never receives more than they asked for at read time). */
export function mistToCtokens(reserve: SuiReserveSnapshot, mist: bigint): bigint {
  if (reserve.ctokenSupply === 0n) return mist;
  return BigInt(
    new BigNumber(mist.toString())
      .times(reserve.ctokenSupply.toString())
      .div(reserve.totalSupplyMist)
      .integerValue(BigNumber.ROUND_FLOOR)
      .toFixed(0),
  );
}

export function chooseObligation(
  obligations: ObligationSnapshot[],
  opts: { obligationId?: string; newObligation?: boolean; allowNew: boolean },
): ObligationChoice {
  if (opts.obligationId && opts.newObligation) {
    throw new RecipeError("INVALID_INPUT", "Use either --obligation-id or --new-obligation, not both");
  }
  if (opts.newObligation) {
    if (!opts.allowNew) throw new RecipeError("INVALID_INPUT", "--new-obligation is only valid for supply");
    return { kind: "new" };
  }
  if (opts.obligationId) {
    const wanted = opts.obligationId.toLowerCase();
    const found = obligations.find((o) => o.obligationId.toLowerCase() === wanted);
    if (!found) {
      throw refuse(`Obligation ${opts.obligationId} is not owned by this address in the SuiLend main market`, {
        owned: obligations.map((o) => o.obligationId),
      });
    }
    return { kind: "existing", obligationId: found.obligationId, capId: found.capId, obligation: found };
  }
  if (obligations.length === 0) {
    if (opts.allowNew) return { kind: "new" };
    throw refuse("This address has no SuiLend main-market obligation, so there is nothing to withdraw");
  }
  if (obligations.length > 1) {
    throw refuse("This address owns several SuiLend obligations; choose one with --obligation-id", {
      owned: obligations.map((o) => o.obligationId),
    });
  }
  const only = obligations[0];
  return { kind: "existing", obligationId: only.obligationId, capId: only.capId, obligation: only };
}

function assertNoBorrows(o: ObligationSnapshot) {
  if (o.borrowCount > 0) {
    throw refuse(
      `Obligation ${o.obligationId} has ${o.borrowCount} borrow(s). This recipe never touches borrowing positions; ` +
        "manage it in the SuiLend app, or supply into a fresh obligation with --new-obligation",
      { obligationId: o.obligationId, borrowCount: o.borrowCount },
    );
  }
}

export function planSupply(input: {
  amountMist: bigint;
  gasReserveMist: bigint;
  wallet: WalletSnapshot;
  market: MarketSnapshot;
  obligations: ObligationSnapshot[];
  obligationId?: string;
  newObligation?: boolean;
}): SupplyPlan {
  const { amountMist, gasReserveMist, wallet, market } = input;
  const warnings: string[] = [];
  const needed = amountMist + gasReserveMist;

  if (wallet.coinObjectMist < needed) {
    const total = wallet.coinObjectMist + wallet.addressBalanceMist;
    const why =
      total >= needed
        ? ` ${formatMist(wallet.addressBalanceMist)} SUI is held as an address balance, which this recipe does not spend.`
        : "";
    throw refuse(
      `Insufficient SUI: supplying ${formatMist(amountMist)} SUI and keeping ${formatMist(gasReserveMist)} SUI for gas ` +
        `needs ${formatMist(needed)} SUI in coin objects, wallet has ${formatMist(wallet.coinObjectMist)}.${why}`,
      { neededMist: needed.toString(), coinObjectMist: wallet.coinObjectMist.toString() },
    );
  }

  const choice = chooseObligation(input.obligations, {
    obligationId: input.obligationId,
    newObligation: input.newObligation,
    allowNew: true,
  });
  if (choice.kind === "existing") {
    assertNoBorrows(choice.obligation);
    if (choice.obligation.suiCtokens === 0n && choice.obligation.depositCount >= MAX_DEPOSITS) {
      throw refuse(`Obligation ${choice.obligationId} already holds ${MAX_DEPOSITS} deposit types (SuiLend maximum)`);
    }
  }

  const reserve = market.sui;
  const headroom = new BigNumber(reserve.depositLimitMist.toString()).minus(reserve.totalSupplyMist);
  if (headroom.lt(amountMist.toString())) {
    const headroomMist = headroom.gt(0) ? BigInt(headroom.integerValue(BigNumber.ROUND_FLOOR).toFixed(0)) : 0n;
    throw refuse(`The SUI reserve deposit limit would be exceeded (headroom ≈ ${formatMist(headroomMist)} SUI)`);
  }

  const expectedCtokens = mistToCtokens(reserve, amountMist);
  if (expectedCtokens === 0n) throw refuse("Amount is too small to mint any cTokens");

  warnings.push("The reserve's USD deposit limit and rate limits are only checked by the pre-submit simulation.");
  return { action: "supply", owner: wallet.address, amountMist, obligation: choice, expectedCtokens, warnings };
}

export function planWithdraw(input: {
  amountMist?: bigint;
  all?: boolean;
  wallet: WalletSnapshot;
  market: MarketSnapshot;
  obligations: ObligationSnapshot[];
  obligationId?: string;
}): WithdrawPlan {
  if (!!input.all === (input.amountMist !== undefined)) {
    throw new RecipeError("INVALID_INPUT", "Withdraw needs exactly one of --amount <SUI> or --all");
  }
  const choice = chooseObligation(input.obligations, { obligationId: input.obligationId, allowNew: false });
  if (choice.kind !== "existing") throw new Error("unreachable");
  const o = choice.obligation;
  assertNoBorrows(o);
  if (o.suiCtokens === 0n) throw refuse(`Obligation ${o.obligationId} has no SUI supplied`);

  const reserve = input.market.sui;
  const suppliedMist = ctokensToMist(reserve, o.suiCtokens);
  const redeemableMist = reserve.availableMist > MIN_AVAILABLE_AMOUNT ? reserve.availableMist - MIN_AVAILABLE_AMOUNT : 0n;
  const warnings: string[] = [];

  if (input.all) {
    const estimatedMist = suppliedMist < redeemableMist ? suppliedMist : redeemableMist;
    if (estimatedMist < suppliedMist) {
      warnings.push(
        `Reserve liquidity (${formatMist(redeemableMist)} SUI) is below your supplied ${formatMist(suppliedMist)} SUI; ` +
          "--all withdraws only what is currently allowed and leaves the rest supplied.",
      );
    }
    warnings.push("--all may also be capped by the market's outflow rate limiter.");
    return {
      action: "withdraw",
      owner: input.wallet.address,
      obligationId: o.obligationId,
      capId: o.capId,
      ctokens: U64_MAX,
      all: true,
      estimatedMist,
      warnings,
    };
  }

  const amountMist = input.amountMist!;
  const ctokens = mistToCtokens(reserve, amountMist);
  if (ctokens === 0n) throw refuse("Amount is too small to correspond to any cTokens");
  if (ctokens > o.suiCtokens) {
    throw refuse(
      `Requested ${formatMist(amountMist)} SUI but only ≈ ${formatMist(suppliedMist)} SUI is supplied; use --all to withdraw everything`,
      { suppliedMist: suppliedMist.toString() },
    );
  }
  const estimatedMist = ctokensToMist(reserve, ctokens);
  if (estimatedMist > redeemableMist) {
    throw refuse(
      `The SUI reserve currently has only ≈ ${formatMist(redeemableMist)} SUI available to withdraw (high utilization); try a smaller amount later`,
    );
  }
  if (estimatedMist < amountMist) {
    warnings.push(
      `cToken rounding: estimated receipt is ${formatMist(estimatedMist)} SUI (interest accrued before execution can only increase it).`,
    );
  }
  return {
    action: "withdraw",
    owner: input.wallet.address,
    obligationId: o.obligationId,
    capId: o.capId,
    ctokens,
    all: false,
    estimatedMist,
    warnings,
  };
}

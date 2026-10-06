import { normalizeStructTag } from "@mysten/sui/utils";

/** SuiLend's main market exists on Sui mainnet only, so the chain is not configurable. */
export const WAAP_CHAIN = "sui:mainnet";
export const DEFAULT_GRPC_URL = "https://fullnode.mainnet.sui.io:443";

export const SUI_COIN_TYPE = normalizeStructTag("0x2::sui::SUI");
export const MIST_PER_SUI = 1_000_000_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

/** Kept in the wallet on supply so the same coin can still pay for gas (and a later withdraw). */
export const DEFAULT_GAS_RESERVE_MIST = 50_000_000n; // 0.05 SUI

/** Pinned versions this recipe was written and tested against. */
export const TESTED_WAAP_CLI_VERSION = "2.2.1";

/**
 * Move functions a recipe transaction may call, by `module::function`.
 * Anything else — in particular `borrow_request` — makes the transaction invalid.
 */
export const ALLOWED_SUILEND_CALLS = new Set([
  "lending_market::create_obligation",
  "lending_market::deposit_liquidity_and_mint_ctokens",
  "lending_market::deposit_ctokens_into_obligation",
  "lending_market::rebalance_staker",
  "lending_market::withdraw_ctokens",
  "lending_market::redeem_ctokens_and_withdraw_liquidity_request",
  "lending_market::unstake_sui_from_staker",
  "lending_market::fulfill_liquidity_request",
]);

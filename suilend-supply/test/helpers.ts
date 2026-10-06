import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BigNumber from "bignumber.js";
import { Inputs, Transaction, type TransactionPlugin } from "@mysten/sui/transactions";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE, SuilendClient } from "@suilend/sdk/client";
import { getPublishedAt } from "@suilend/sdk/_generated/_framework/env";
import type { SuilendCalls } from "../src/ptb.js";
import type { ChainPort, MarketSnapshot, ObligationSnapshot, SimulationOutcome, WalletSnapshot } from "../src/types.js";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_WAAP = path.join(HERE, "fixtures", "fake-waap-cli.mjs");

/** Synthetic owner address and object ids — NOT real chain data. */
export const OWNER = "0x" + "a1".repeat(32);
export const CAP_A = "0x" + "c1".repeat(32);
export const CAP_B = "0x" + "c2".repeat(32);
export const OBL_A = "0x" + "0a".repeat(32);
export const OBL_B = "0x" + "0b".repeat(32);
export const SUI_INDEX = 2n;

export const MIST = 1_000_000_000n;

/**
 * Controlled substitute for on-chain object resolution. Mutability mirrors the Move signatures
 * in source d5ba83a: every recipe call takes `&mut LendingMarket`, `&Clock`, `&mut SuiSystemState`
 * (rebalance/unstake) and `&ObligationOwnerCap`. Versions/digests are synthetic.
 */
const OBJECTS: Record<string, { shared: true; isv: number; mutable: boolean } | { shared: false; version: number }> = {
  [normalizeSuiObjectId(LENDING_MARKET_ID)]: { shared: true, isv: 101, mutable: true },
  [normalizeSuiObjectId("0x6")]: { shared: true, isv: 1, mutable: false },
  [normalizeSuiObjectId("0x5")]: { shared: true, isv: 1, mutable: true },
  [normalizeSuiObjectId(CAP_A)]: { shared: false, version: 7 },
  [normalizeSuiObjectId(CAP_B)]: { shared: false, version: 9 },
};
const FAKE_DIGEST = "11111111111111111111111111111111";

export const fakeResolver: TransactionPlugin = async (data, _options, next) => {
  data.inputs.forEach((input, i) => {
    if (input.$kind !== "UnresolvedObject") return;
    const id = normalizeSuiObjectId(input.UnresolvedObject.objectId);
    const f = OBJECTS[id];
    if (!f) throw new Error(`fake resolver: unknown object ${id}`);
    data.inputs[i] = f.shared
      ? Inputs.SharedObjectRef({ objectId: id, initialSharedVersion: f.isv, mutable: f.mutable })
      : Inputs.ObjectRef({ objectId: id, version: f.version, digest: FAKE_DIGEST });
  });
  await next();
};

export async function buildKindOffline(build: (tx: Transaction) => void | Promise<void>): Promise<Uint8Array> {
  const tx = new Transaction();
  await build(tx);
  tx.addBuildPlugin(fakeResolver);
  return tx.build({ onlyTransactionKind: true });
}

/** A real SuilendClient (its methods are the SDK's own PTB builders) over a stub market object. */
export function stubSuilend(): SuilendCalls {
  const client = Object.create(SuilendClient.prototype);
  client.lendingMarket = {
    id: LENDING_MARKET_ID,
    $typeArgs: [LENDING_MARKET_TYPE],
    reserves: [
      { coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" },
      { coinType: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN" },
      { coinType: "0x2::sui::SUI" },
    ],
  };
  return client;
}

export function market(overrides: Partial<MarketSnapshot["sui"]> = {}): MarketSnapshot {
  return {
    lendingMarketId: LENDING_MARKET_ID,
    lendingMarketType: LENDING_MARKET_TYPE,
    publishedAt: getPublishedAt("suilend"),
    readAtMs: Date.UTC(2026, 9, 3),
    sui: {
      arrayIndex: SUI_INDEX,
      availableMist: 1_000_000n * MIST,
      ctokenSupply: 2_000_000n * MIST,
      // exchange rate 1.05 SUI per cToken (synthetic)
      totalSupplyMist: new BigNumber((2_100_000n * MIST).toString()),
      depositLimitMist: 10_000_000n * MIST,
      depositAprPercent: "2.5000",
      ...overrides,
    },
  };
}

export function wallet(coinSui: bigint, addressSui = 0n): WalletSnapshot {
  return { address: OWNER, coinObjectMist: coinSui, addressBalanceMist: addressSui };
}

export function obligation(o: Partial<ObligationSnapshot> = {}): ObligationSnapshot {
  return {
    obligationId: OBL_A,
    capId: CAP_A,
    suiCtokens: 10n * MIST,
    otherDeposits: [],
    depositCount: 1,
    borrowCount: 0,
    ...o,
  };
}

export interface FakeChainState {
  market: MarketSnapshot;
  wallet: WalletSnapshot;
  obligations: ObligationSnapshot[];
  simulation?: SimulationOutcome;
  reads: string[];
  simulated: { kind: Uint8Array; sender: string }[];
}

export function fakeChain(state: Partial<FakeChainState> = {}) {
  const s: FakeChainState = {
    market: market(),
    wallet: wallet(100n * MIST),
    obligations: [obligation()],
    reads: [],
    simulated: [],
    ...state,
  };
  const port: ChainPort = {
    async readMarket() {
      s.reads.push("market");
      return s.market;
    },
    async readWallet(a) {
      s.reads.push(`wallet:${a}`);
      return { ...s.wallet, address: a };
    },
    async readObligations(a) {
      s.reads.push(`obligations:${a}`);
      return s.obligations;
    },
    buildKind: buildKindOffline,
    async simulate(kind, sender) {
      s.simulated.push({ kind, sender });
      return s.simulation ?? { ok: true };
    },
    async chainIdentifier() {
      return "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"; // Sui mainnet
    },
    async latestCheckpoint() {
      return 1000n;
    },
    async transactionInfo(d) {
      // Static chain: nothing a send does ever becomes visible (use world-chain.ts for that).
      s.reads.push(`tx:${d}`);
      return { status: "not_found" as const };
    },
  };
  return { state: s, deps: async () => ({ port, suilend: stubSuilend() }) };
}

export function tmpDir(prefix: string): string {
  const base = path.join(HERE, "..", ".test-tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

export function readLog(file: string): { args: string[]; stdin: string; at: number }[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export { os };

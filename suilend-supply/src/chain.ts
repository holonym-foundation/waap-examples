import { createHash } from "node:crypto";
import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SimulationError, TransactionError } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE, SuilendClient } from "@suilend/sdk/client";
import { getPublishedAt } from "@suilend/sdk/_generated/_framework/env";
import * as simulate from "@suilend/sdk/utils/simulate";
import { SUI_COIN_TYPE } from "./constants.js";
import { RecipeError } from "./errors.js";
import type { SuilendCalls } from "./ptb.js";
import type { ChainPort, MarketSnapshot, ObligationSnapshot, SimulationOutcome, TransactionInfo, WalletSnapshot } from "./types.js";

/** Move abort codes from SuiLend source d5ba83a, for readable simulation failures. */
const ABORTS: Record<string, Record<string, string>> = {
  lending_market: { "1": "market version mismatch (SuiLend upgraded; update @suilend/sdk)", "2": "amount too small" },
  reserve: {
    "2": "SUI reserve deposit limit reached",
    "5": "withdrawal would drain the reserve below its minimum (not enough liquidity)",
  },
  obligation: { "1": "obligation would become unhealthy", "5": "too many deposit types in obligation" },
  rate_limiter: { "2": "SuiLend outflow rate limit reached; try a smaller amount later" },
};

/** Move `TypeName` as decoded by the SDK (string or `{name}`; with or without 0x) → normalized tag. */
export const typeNameToString = (t: unknown): string => {
  const raw = typeof t === "string" ? t : String((t as { name?: string })?.name ?? t);
  return normalizeStructTag(/^0x/i.test(raw) ? raw : `0x${raw}`);
};

interface RawObligation {
  id: string;
  deposits: { coinType: unknown; depositedCtokenAmount: { toString(): string } }[];
  borrows: unknown[];
}

/** Pair obligations with their owner caps by normalized id and summarize them. Pure; tested offline. */
export function mapObligations(caps: { id: string; obligationId: string }[], obligations: RawObligation[]): ObligationSnapshot[] {
  return obligations.map((o) => {
    const cap = caps.find((c) => normalizeSuiObjectId(c.obligationId) === normalizeSuiObjectId(o.id));
    if (!cap) throw new RecipeError("UNEXPECTED", `No owner cap found for obligation ${o.id}`);
    const deposits = o.deposits.map((d) => ({
      coinType: typeNameToString(d.coinType),
      ctokens: BigInt(d.depositedCtokenAmount.toString()),
    }));
    return {
      obligationId: o.id,
      capId: cap.id,
      suiCtokens: deposits.filter((d) => d.coinType === SUI_COIN_TYPE).reduce((s, d) => s + d.ctokens, 0n),
      otherDeposits: deposits.filter((d) => d.coinType !== SUI_COIN_TYPE),
      depositCount: deposits.length,
      borrowCount: o.borrows.length,
    };
  });
}

export function explainExecutionError(err: { message?: string; MoveAbort?: { abortCode: string; location?: { module?: string } } } | undefined): {
  reason: string;
  abort?: { module?: string; code?: string };
} {
  const abort = err?.MoveAbort;
  if (abort) {
    const mod = abort.location?.module;
    const known = mod ? ABORTS[mod]?.[abort.abortCode] : undefined;
    return {
      reason: known ?? `Move abort ${abort.abortCode} in ${mod ?? "unknown module"}`,
      abort: { module: mod, code: abort.abortCode },
    };
  }
  return { reason: err?.message ?? "simulation failed" };
}

/**
 * The reads reconciliation depends on (F1): chain identifier and a transaction's sender, gas
 * owner, gas paid and SUI balance changes. Separate from `connectLiveChain` so they can be
 * exercised through the real `SuiGrpcClient` and protobuf decoding with a controlled transport.
 */
export function txReads(client: SuiGrpcClient): Pick<ChainPort, "chainIdentifier" | "transactionInfo" | "latestCheckpoint"> {
  return {
    async latestCheckpoint() {
      const { response } = await client.ledgerService.getServiceInfo({});
      if (response.checkpointHeight === undefined) throw new RecipeError("UNEXPECTED", "the read node did not report a checkpoint height");
      return BigInt(response.checkpointHeight);
    },

    async chainIdentifier() {
      return (await client.core.getChainIdentifier()).chainIdentifier;
    },

    async transactionInfo(digest: string): Promise<TransactionInfo> {
      let res;
      try {
        res = await client.core.getTransaction({ digest, include: { effects: true, transaction: true, balanceChanges: true, bcs: true } });
      } catch (e) {
        if (e instanceof TransactionError && e.reason === "notFound") return { status: "not_found" };
        throw e; // transport/other errors are not "not found"
      }
      const t = res.$kind === "Transaction" ? res.Transaction : res.FailedTransaction;
      const gas = t.effects.gasUsed;
      const suiChangeMist: Record<string, bigint> = {};
      for (const b of t.balanceChanges) {
        if (normalizeStructTag(b.coinType) !== SUI_COIN_TYPE) continue;
        const a = normalizeSuiAddress(b.address);
        suiChangeMist[a] = (suiChangeMist[a] ?? 0n) + BigInt(b.amount);
      }
      const sender = t.transaction.sender;
      if (!sender) throw new RecipeError("UNEXPECTED", `transaction ${digest} has no sender in the node response`);
      return {
        status: t.status.success ? "success" : "failure",
        sender,
        gasOwner: t.transaction.gasData.owner ?? sender,
        gasPaidMist: BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate),
        suiChangeMist,
        kindSha256: kindSha256(t.bcs),
        checkpoint: t.checkpoint ? BigInt(t.checkpoint) : undefined,
      };
    },
  };
}

/** SHA-256 (hex) of the TransactionKind inside a BCS TransactionData, or undefined if absent/unparseable. */
export function kindSha256(txDataBcs: Uint8Array | undefined): string | undefined {
  if (!txDataBcs) return undefined;
  try {
    const data = bcs.TransactionData.parse(txDataBcs);
    const kind = bcs.TransactionKind.serialize(data.V1.kind).toBytes();
    return createHash("sha256").update(kind).digest("hex");
  } catch {
    return undefined;
  }
}

export interface LiveChain {
  port: ChainPort;
  suilend: SuilendCalls;
}

/**
 * Production adapter: Sui gRPC full node + @suilend/sdk. Not exercised by the offline test
 * suite (no live RPC was allowed); it is type-checked only.
 */
export async function connectLiveChain(grpcUrl: string): Promise<LiveChain> {
  const client = new SuiGrpcClient({ network: "mainnet", baseUrl: grpcUrl });
  // initialize() reads the market on chain, checks its version and selects the matching
  // published-at package for every move call the SDK builds afterwards.
  let suilend = await SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, client);

  const port: ChainPort = {
    async readMarket(): Promise<MarketSnapshot> {
      suilend = await SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, client);
      const reserves = suilend.lendingMarket.reserves;
      const idx = reserves.findIndex((r) => typeNameToString(r.coinType) === SUI_COIN_TYPE);
      if (idx < 0) throw new RecipeError("UNEXPECTED", "SUI reserve not found in the SuiLend main market");
      const nowMs = Date.now();
      const r = simulate.compoundReserveInterest(reserves[idx], Math.floor(nowMs / 1000));
      const config = r.config.element;
      if (!config) throw new RecipeError("UNEXPECTED", "SUI reserve has no config");
      return {
        lendingMarketId: suilend.lendingMarket.id,
        lendingMarketType: LENDING_MARKET_TYPE,
        publishedAt: getPublishedAt("suilend"),
        readAtMs: nowMs,
        sui: {
          arrayIndex: BigInt(idx),
          availableMist: BigInt(r.availableAmount.toString()),
          ctokenSupply: BigInt(r.ctokenSupply.toString()),
          totalSupplyMist: simulate.totalSupply(r),
          depositLimitMist: BigInt(config.depositLimit.toString()),
          depositAprPercent: simulate.calculateDepositAprPercent(r).toFixed(4),
        },
      };
    },

    async readWallet(address: string): Promise<WalletSnapshot> {
      const { balance } = await client.core.getBalance({ owner: address, coinType: SUI_COIN_TYPE });
      return {
        address,
        coinObjectMist: BigInt(balance.coinBalance ?? balance.balance),
        addressBalanceMist: BigInt(balance.addressBalance ?? "0"),
      };
    },

    async readObligations(address: string): Promise<ObligationSnapshot[]> {
      const types = [LENDING_MARKET_TYPE];
      const caps = await SuilendClient.getObligationOwnerCaps(address, types, client);
      if (caps.length === 0) return [];
      const obligations = await SuilendClient.getObligations(
        caps.map((c) => c.obligationId),
        types,
        client,
      );
      return mapObligations(caps, obligations);
    },

    async buildKind(build) {
      const tx = new Transaction();
      await build(tx);
      return tx.build({ client, onlyTransactionKind: true });
    },

    async simulate(kind: Uint8Array, sender: string): Promise<SimulationOutcome> {
      const tx = Transaction.fromKind(kind);
      tx.setSender(sender);
      try {
        const res = await client.core.simulateTransaction({ transaction: tx, include: { effects: true } });
        const t = res.$kind === "Transaction" ? res.Transaction : res.FailedTransaction;
        if (t.status.success) return { ok: true };
        return { ok: false, ...explainExecutionError(t.status.error as never) };
      } catch (e) {
        if (e instanceof SimulationError) return { ok: false, ...explainExecutionError((e.executionError ?? { message: e.message }) as never) };
        throw e;
      }
    },

    ...txReads(client),
  };

  return { port, suilend: new Proxy({} as SuilendCalls, { get: (_t, p) => (suilend as any)[p].bind(suilend) }) };
}

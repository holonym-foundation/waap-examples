import { createHash } from "node:crypto";
// Repair round 01: ChainPort over the shared world file (test/fixtures/world.mjs). Real SDK
// builders and serialization; only object resolution and chain reads are substituted.
import fs from "node:fs";
import path from "node:path";
import BigNumber from "bignumber.js";
import { Inputs, Transaction, type TransactionPlugin } from "@mysten/sui/transactions";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE } from "@suilend/sdk/client";
import { getPublishedAt } from "@suilend/sdk/_generated/_framework/env";
import type { ChainPort } from "../src/types.js";
// @ts-expect-error untyped fixture module
import { readWorld, withWorld, tick } from "./fixtures/world.mjs";
import { SUI_INDEX, stubSuilend } from "./helpers.js";

const SHARED: Record<string, { isv: number; mutable: boolean }> = {
  [normalizeSuiObjectId(LENDING_MARKET_ID)]: { isv: 101, mutable: true },
  [normalizeSuiObjectId("0x6")]: { isv: 1, mutable: false },
  [normalizeSuiObjectId("0x5")]: { isv: 1, mutable: true },
};

function resolver(worldFile: string): TransactionPlugin {
  return async (data, _o, next) => {
    const caps = new Set<string>(readWorld(worldFile).obligations.map((o: any) => normalizeSuiObjectId(o.capId)));
    data.inputs.forEach((input, i) => {
      if (input.$kind !== "UnresolvedObject") return;
      const id = normalizeSuiObjectId(input.UnresolvedObject.objectId);
      const s = SHARED[id];
      if (s) data.inputs[i] = Inputs.SharedObjectRef({ objectId: id, initialSharedVersion: s.isv, mutable: s.mutable });
      else if (caps.has(id)) data.inputs[i] = Inputs.ObjectRef({ objectId: id, version: 7, digest: "11111111111111111111111111111111" });
      else throw new Error(`world resolver: unknown object ${id}`);
    });
    await next();
  };
}

/** Wait until `n` processes have reached this point (deterministic race window), or 3 s. */
function barrier() {
  const dir = process.env.FAKE_BARRIER_DIR;
  if (!dir) return;
  const n = Number(process.env.FAKE_BARRIER_N ?? 2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(process.pid)), "");
  const until = Date.now() + 3000;
  while (fs.readdirSync(dir).length < n && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

export function worldChain(worldFile: string) {
  const read = <T>(fn: (w: any) => T): T => withWorld(worldFile, (w: any) => (tick(w), fn(w)));
  const port = {
    async chainIdentifier() {
      return read((w) => w.chainId as string);
    },
    async latestCheckpoint() {
      return read((w) => BigInt(w.checkpoint ?? 0));
    },
    async readMarket() {
      return read((w) => {
        if (w.fail?.market) throw new Error(w.fail.market);
        return {
          lendingMarketId: LENDING_MARKET_ID,
          lendingMarketType: LENDING_MARKET_TYPE,
          publishedAt: getPublishedAt("suilend"),
          readAtMs: Date.UTC(2026, 9, 3),
          sui: {
            arrayIndex: SUI_INDEX,
            availableMist: BigInt(w.market.availableMist),
            ctokenSupply: BigInt(w.market.ctokenSupply),
            totalSupplyMist: new BigNumber(w.market.totalSupplyMist),
            depositLimitMist: BigInt(w.market.depositLimitMist),
            depositAprPercent: "2.5000",
          },
        };
      });
    },
    async readWallet(address: string) {
      return read((w) => {
        if (w.fail?.wallet) throw new Error(w.fail.wallet);
        const mine = normalizeSuiAddress(address) === normalizeSuiAddress(w.wallet.address);
        return { address, coinObjectMist: mine ? BigInt(w.wallet.coinMist) : 0n, addressBalanceMist: 0n };
      });
    },
    async readObligations(address: string) {
      return read((w) => {
        if (w.fail?.obligations) throw new Error(w.fail.obligations);
        if (normalizeSuiAddress(address) !== normalizeSuiAddress(w.wallet.address)) return [];
        return w.obligations.map((o: any) => ({ ...o, suiCtokens: BigInt(o.suiCtokens), otherDeposits: o.otherDeposits ?? [] }));
      });
    },
    async buildKind(build: (tx: Transaction) => void | Promise<void>) {
      const tx = new Transaction();
      await build(tx);
      tx.addBuildPlugin(resolver(worldFile));
      return tx.build({ onlyTransactionKind: true });
    },
    async simulate() {
      barrier();
      return read((w) => w.simulation ?? { ok: true });
    },
    async transactionStatus(digest: string) {
      return read((w) => {
        const t = w.txs[digest];
        return !t ? "not_found" : t.status === "success" ? "success" : "failure";
      });
    },
    async transactionInfo(digest: string) {
      return read((w) => {
        if (w.fail?.tx) throw new Error(w.fail.tx);
        const t = w.txs[digest];
        if (!t) return { status: "not_found" as const };
        return {
          status: t.status === "success" ? ("success" as const) : ("failure" as const),
          sender: t.sender as string,
          gasOwner: t.gasOwner as string,
          gasPaidMist: BigInt(t.gasMist),
          suiChangeMist: Object.fromEntries(Object.entries(t.suiChange).map(([a, v]) => [normalizeSuiAddress(a), BigInt(v as string)])),
          // the executed kind = the bytes waap-cli received (the fake WaaP does not rewrite them)
          checkpoint: t.checkpoint === undefined ? undefined : BigInt(t.checkpoint),
          kindSha256: t.kindBase64 ? createHash("sha256").update(Buffer.from(t.kindBase64 as string, "base64")).digest("hex") : undefined,
        };
      });
    },
  };
  return { port: port as unknown as ChainPort, deps: async () => ({ port: port as unknown as ChainPort, suilend: stubSuilend() }) };
}

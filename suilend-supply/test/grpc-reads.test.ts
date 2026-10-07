// What this proves: the real `txReads(client)` from src/chain.ts runs through a real
// `SuiGrpcClient` whose `transport` is an in-process fake protobuf-ts RpcTransport. Canned
// responses are built with the SDK's generated message types and round-tripped through
// toBinary/fromBinary, so the SDK's real client code (read masks, NOT_FOUND mapping in
// grpc/core.mjs getTransaction) and its protobuf decoding/parsing (parseGrpcTransactionResponse,
// grpcTransactionToTransactionData) all execute. No `@mysten/sui` module is mocked and no socket opens.
// What it does NOT prove: that a live Sui full node populates these fields the way the canned
// messages do (sender, gas_payment.owner, balance_changes, effects.gas_used under the requested
// read mask), or that the node's NOT_FOUND status is what it returns for an unknown digest. The
// field placement here follows the SDK's own parser and generated proto types, not live traffic.
import { describe, expect, it } from "vitest";
import { GrpcStatusCode, GrpcTypes, RpcError, SuiGrpcClient } from "@mysten/sui/grpc";
import { UnaryCall } from "@protobuf-ts/runtime-rpc";
import type { MethodInfo, RpcOptions, RpcTransport } from "@protobuf-ts/runtime-rpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { createHash } from "node:crypto";
import { Transaction } from "@mysten/sui/transactions";
import { kindSha256, txReads } from "../src/chain.js";

const MAINNET_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const S = normalizeSuiAddress("0xa11ce");
const G = normalizeSuiAddress("0x5b0b5");
const OTHER = normalizeSuiAddress("0xb0b");
const SUI_SHORT = "0x2::sui::SUI";
const DIGEST = "8d3dYGYAL7pSbpS9a6GBmQDkMZuLXbWmJz7ykt8UqL5b";

type Handler = (method: MethodInfo, input: object) => object;

/** Fake protobuf-ts transport: dispatches on RPC name, returns binary-round-tripped messages. */
function fakeTransport(handler: Handler, calls: string[] = []): RpcTransport {
  const transport = {
    mergeOptions: (o?: Partial<RpcOptions>): RpcOptions => ({ ...o }),
    unary(method: MethodInfo, input: object, _options: RpcOptions) {
      calls.push(method.name);
      let response: Promise<object>;
      try {
        const msg = handler(method, input);
        const O = method.O as { toBinary(m: object): Uint8Array; fromBinary(b: Uint8Array): object };
        response = Promise.resolve(O.fromBinary(O.toBinary(msg)));
      } catch (e) {
        response = Promise.reject(e);
        response.catch(() => {}); // the call's other promises settle too; avoid unhandled rejections
      }
      const ok = response.then(() => ({ code: "OK", detail: "" }));
      ok.catch(() => {});
      return new UnaryCall(method as MethodInfo<any, any>, {}, input as any, Promise.resolve({}), response as any, ok as any, Promise.resolve({}));
    },
    serverStreaming: () => { throw new Error("unused"); },
    clientStreaming: () => { throw new Error("unused"); },
    duplex: () => { throw new Error("unused"); },
  };
  return transport as unknown as RpcTransport;
}

const clientFor = (handler: Handler, calls?: string[]) =>
  new SuiGrpcClient({ network: "mainnet", transport: fakeTransport(handler, calls) });

interface TxOpts {
  sender?: string;
  gasOwner?: string;
  success?: boolean;
  balanceChanges?: { address: string; coinType: string; amount: string }[];
  /** Raw BCS TransactionData (follow-up R1: the kind hash is read from it). */
  bcs?: Uint8Array;
  checkpoint?: bigint;
}

function executedTransaction(o: TxOpts) {
  const T = GrpcTypes;
  return T.GetTransactionResponse.create({
    transaction: T.ExecutedTransaction.create({
      digest: DIGEST,
      ...(o.checkpoint !== undefined ? { checkpoint: o.checkpoint } : {}),
      transaction: T.Transaction.create({
        version: 1,
        ...(o.bcs ? { bcs: T.Bcs.create({ value: o.bcs }) } : {}),
        sender: o.sender ?? S,
        kind: T.TransactionKind.create({
          data: { oneofKind: "programmableTransaction", programmableTransaction: T.ProgrammableTransaction.create({}) },
        }),
        gasPayment: T.GasPayment.create({ owner: o.gasOwner ?? o.sender ?? S, budget: 10_000_000n, price: 1000n }),
      }),
      effects: T.TransactionEffects.create({
        // A real node attaches an ExecutionError to every failed status; the SDK's effects parser
        // (parseGrpcExecutionError) dereferences it, so a failed canned status must carry one.
        status: T.ExecutionStatus.create(
          o.success === false
            ? { success: false, error: T.ExecutionError.create({ description: "InsufficientGas", kind: T.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS }) }
            : { success: true },
        ),
        gasUsed: T.GasCostSummary.create({ computationCost: 1000n, storageCost: 2000n, storageRebate: 500n, nonRefundableStorageFee: 5n }),
      }),
      balanceChanges: (o.balanceChanges ?? []).map((b) => T.BalanceChange.create(b)),
    }),
  });
}

const txHandler = (o: TxOpts): Handler => (m) => {
  if (m.name !== "GetTransaction") throw new Error(`unexpected rpc ${m.name}`);
  return executedTransaction(o);
};

describe("txReads through the real SuiGrpcClient with a fake protobuf transport", () => {
  it("1. chainIdentifier comes from GetServiceInfo.chain_id", async () => {
    const calls: string[] = [];
    const client = clientFor((m) => {
      if (m.name !== "GetServiceInfo") throw new Error(`unexpected rpc ${m.name}`);
      return GrpcTypes.GetServiceInfoResponse.create({ chainId: MAINNET_ID, chain: "mainnet" });
    }, calls);
    expect(await txReads(client).chainIdentifier()).toBe(MAINNET_ID);
    expect(calls).toEqual(["GetServiceInfo"]);
  });

  it("2. successful tx: sender, gas owner, gas paid, SUI changes summed per normalized address, other coins ignored", async () => {
    const client = clientFor(
      txHandler({
        balanceChanges: [
          { address: S, coinType: SUI_SHORT, amount: String(-(1_000_000_000 + 2500)) },
          { address: S, coinType: "0x" + "d".repeat(64) + "::usdc::USDC", amount: "-777" },
          { address: "0xb0b", coinType: SUI_SHORT, amount: "400" },
          { address: OTHER, coinType: normalizeSuiAddress("0x2") + "::sui::SUI", amount: "250" },
        ],
      }),
    );
    const info = await txReads(client).transactionInfo(DIGEST);
    expect(info).toEqual({
      status: "success",
      sender: S,
      gasOwner: S,
      gasPaidMist: 2500n,
      suiChangeMist: { [S]: -(1_000_000_000n + 2500n), [OTHER]: 650n },
    });
    expect(Object.keys((info as { suiChangeMist: object }).suiChangeMist).sort()).toEqual([S, OTHER].sort());
  });

  it("3. failed execution reports status failure and still parses the sender", async () => {
    const client = clientFor(txHandler({ success: false, balanceChanges: [{ address: S, coinType: SUI_SHORT, amount: "-2500" }] }));
    const info = await txReads(client).transactionInfo(DIGEST);
    expect(info).toMatchObject({ status: "failure", sender: S, gasOwner: S, gasPaidMist: 2500n });
    expect((info as { suiChangeMist: Record<string, bigint> }).suiChangeMist[S]).toBe(-2500n);
  });

  it("4. sponsored gas: gas owner differs from the sender", async () => {
    const client = clientFor(txHandler({ gasOwner: G, balanceChanges: [{ address: G, coinType: SUI_SHORT, amount: "-2500" }] }));
    const info = await txReads(client).transactionInfo(DIGEST);
    expect(info).toMatchObject({ status: "success", sender: S, gasOwner: G });
    expect((info as { suiChangeMist: Record<string, bigint> }).suiChangeMist).toEqual({ [G]: -2500n });
  });

  it("5. gRPC NOT_FOUND maps to TransactionError notFound and becomes status not_found", async () => {
    // grpc/core.mjs getTransaction: RpcError with code === "NOT_FOUND" -> TransactionError("notFound").
    const client = clientFor(() => {
      throw new RpcError("transaction not found", GrpcStatusCode[GrpcStatusCode.NOT_FOUND]);
    });
    expect(await txReads(client).transactionInfo(DIGEST)).toEqual({ status: "not_found" });
  });

  it("5b. an empty GetTransactionResponse (no transaction) is also notFound in the SDK", async () => {
    const client = clientFor(() => GrpcTypes.GetTransactionResponse.create({}));
    expect(await txReads(client).transactionInfo(DIGEST)).toEqual({ status: "not_found" });
  });

  it("6. transport errors reject and are never reported as not_found", async () => {
    const unavailable = clientFor(() => {
      throw new RpcError("connection refused", GrpcStatusCode[GrpcStatusCode.UNAVAILABLE]);
    });
    await expect(txReads(unavailable).transactionInfo(DIGEST)).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const plain = clientFor(() => {
      throw new Error("socket hang up");
    });
    await expect(txReads(plain).transactionInfo(DIGEST)).rejects.toThrow("socket hang up");
  });

  // Follow-up R1 (added by the parent executor, not the Sonnet worker): kind hash from the raw BCS.
  it("7. kindSha256: hash of the TransactionKind inside the node's BCS TransactionData; absent BCS → undefined", async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.gas, [tx.pure.u64(5n)]);
    const kind = await tx.build({ onlyTransactionKind: true });
    const full = Transaction.fromKind(kind);
    full.setSender(S);
    full.setGasOwner(S);
    full.setGasPrice(1000);
    full.setGasBudget(10_000_000);
    full.setGasPayment([{ objectId: normalizeSuiAddress("0x99"), version: "1", digest: DIGEST }]);
    const data = await full.build();
    const expected = createHash("sha256").update(kind).digest("hex");
    expect(kindSha256(data)).toBe(expected);
    const info = await txReads(clientFor(txHandler({ bcs: data }))).transactionInfo(DIGEST);
    expect(info).toMatchObject({ status: "success", kindSha256: expected });
    const without = await txReads(clientFor(txHandler({}))).transactionInfo(DIGEST);
    expect(without.status === "success" && without.kindSha256).toBeUndefined();
  });

  // Follow-up 2 (parent executor): chain-clock identity reads.
  it("8. latestCheckpoint reads GetServiceInfo.checkpoint_height; a transaction's checkpoint is parsed, undefined if absent", async () => {
    const calls: string[] = [];
    const reads = txReads(clientFor((m) => {
      if (m.name !== "GetServiceInfo") throw new Error(`unexpected rpc ${m.name}`);
      return GrpcTypes.GetServiceInfoResponse.create({ chainId: MAINNET_ID, chain: "mainnet", checkpointHeight: 271828n });
    }, calls));
    expect(await reads.latestCheckpoint()).toBe(271828n);
    expect(calls).toEqual(["GetServiceInfo"]);
    const withCp = await txReads(clientFor(txHandler({ checkpoint: 271829n }))).transactionInfo(DIGEST);
    expect(withCp).toMatchObject({ status: "success", checkpoint: 271829n });
    const without = await txReads(clientFor(txHandler({}))).transactionInfo(DIGEST);
    expect(without.status === "success" && without.checkpoint).toBeUndefined();
  });
});

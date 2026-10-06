import { SuiGrpcClient } from "@mysten/sui/grpc";
import { kindSha256 } from "../../src/chain.ts";
const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io:443" });
const digest = process.argv[2];
for (let i = 0; i < 6; i++) {
  try {
    const res: any = await client.core.getTransaction({ digest, include: { effects: true, transaction: true, balanceChanges: true, bcs: true, objectTypes: true } });
    const t = res.$kind === "Transaction" ? res.Transaction : res.FailedTransaction;
    const e = t.effects;
    const out = {
      digest, success: t.status.success, status: t.status, checkpoint: String(t.checkpoint ?? ""),
      sender: t.transaction.sender, gasOwner: t.transaction.gasData.owner, gasBudget: String(t.transaction.gasData.budget), gasPrice: String(t.transaction.gasData.price),
      gasUsed: e.gasUsed, gasNetMist: String(BigInt(e.gasUsed.computationCost) + BigInt(e.gasUsed.storageCost) - BigInt(e.gasUsed.storageRebate)),
      balanceChanges: t.balanceChanges, kindSha256: kindSha256(t.bcs),
      changedObjects: (e.changedObjects ?? []).map((o: any) => ({ id: o.objectId, idOp: o.idOperation, out: o.outputState, owner: o.outputOwner, type: t.objectTypes?.[o.objectId] })),
    };
    console.log(JSON.stringify(out, (_k, v) => typeof v === "bigint" ? String(v) : v, 1));
    process.exit(0);
  } catch (err) { console.error("retry", String(err)); await new Promise(r => setTimeout(r, 2500)); }
}
process.exit(1);

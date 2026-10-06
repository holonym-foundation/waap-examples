// Probe 2 (2026-10-03): which client methods does Transaction#build({onlyTransactionKind})
// call to resolve object inputs? Uses a logging Proxy client; no network.
globalThis.fetch = (async (u: any) => { throw new Error("NETWORK_BLOCKED " + u); }) as any;
const { Transaction } = await import("@mysten/sui/transactions");
const log: string[] = [];
function mk(path: string): any {
  return new Proxy(function () {}, {
    get(_t, p) { if (p === "then") return undefined; return mk(path + "." + String(p)); },
    apply(_t, _this, args) { log.push(path + " " + JSON.stringify(args, (k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 300)); throw new Error("stop at " + path); },
  });
}
const tx = new Transaction();
tx.moveCall({ target: "0x59672975e15c58ffc9450f5236b6aa9fa2407d94b8081e634778aa01957d8c6f::lending_market::create_obligation", typeArguments: ["0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::suilend::MAIN_POOL"], arguments: [tx.object("0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1"), tx.object("0x6")] });
try { await tx.build({ onlyTransactionKind: true, client: mk("client") }); } catch (e: any) { console.log("err:", e.message.slice(0, 200)); }
console.log(log.join("\n"));

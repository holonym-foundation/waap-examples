// Probe 1 (2026-10-03): does @suilend/sdk import offline, and can a deposit PTB be
// built to TransactionKind bytes with no live RPC? Network is blocked by a fetch trap.
const calls: string[] = [];
globalThis.fetch = (async (u: any) => { calls.push(String(u)); throw new Error("NETWORK_BLOCKED " + u); }) as any;
const sdk = await import("@suilend/sdk");
const { Transaction } = await import("@mysten/sui/transactions");
console.log("exports sample:", Object.keys(sdk).filter(k => /LENDING_MARKET|SuilendClient|getPublishedAt|setPublishedAt|parseObligation/.test(k)));
const client: any = Object.create(sdk.SuilendClient.prototype);
client.lendingMarket = { id: sdk.LENDING_MARKET_ID, $typeArgs: [sdk.LENDING_MARKET_TYPE], reserves: [{ coinType: "0x2::sui::SUI" }] };
const tx = new Transaction();
const [cap] = client.createObligation(tx);
const [coin] = tx.splitCoins(tx.gas, [1_000_000_000n]);
client.deposit(coin, "0x2::sui::SUI", cap, tx);
tx.transferObjects([cap], "0x" + "ab".repeat(32));
console.log(JSON.stringify(tx.getData().commands.map((c: any) => c.MoveCall ? `${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}` : c.$kind), null, 1));
try { const b = await tx.build({ onlyTransactionKind: true }); console.log("built without client, bytes", b.length); } catch (e: any) { console.log("build w/o client error:", e.message.slice(0, 300)); }
console.log("network calls attempted:", calls);

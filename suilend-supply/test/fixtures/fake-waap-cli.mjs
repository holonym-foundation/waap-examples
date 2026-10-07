#!/usr/bin/env node
// Controlled substitute for `waap-cli`. Behaviour comes from FAKE_WAAP_SCENARIO; every call's
// argv and stdin are appended to FAKE_WAAP_LOG so tests can assert exactly what was sent.
//
// Where each shape comes from (waap-cli 2.2.1 dist/index.js, minified names). These are inferred
// from bundle source plus README/.agent/SKILL.md, not from observing the live service:
//   NDJSON line   G(e,t)  → stdout `{"event":e,...t}` only in --json mode
//   result/error  $(cmd,auth,fn): success → G("result", value); failure → G("error",{code,message,command})
//                 then exit code Uv[code] (README table: 2 NO_SESSION … 9 RPC_PROTOCOL_MISMATCH)
//   whoami        Xv → {email?, evmWalletAddress, suiWalletAddress, solanaWalletAddress}
//   transaction   Eb → wb(result) where the Sui handler result is {from, txHash, operationId};
//                 wb adds status confirmed|failed|pending (+pending, confirmationError) and
//                 RETURNS normally, so an on-chain failure still exits 0
//   awaiting_2fa  mh → G("awaiting_2fa",{method,payload_id,timeout_ms,expires_in_seconds?,confirm_url?});
//                 for method "phone_authz" it then calls dh(), a readline prompt on the
//                 process's own stdin/stdout for a 6-digit code
import fs from "node:fs";

const scenario = process.env.FAKE_WAAP_SCENARIO ?? "ok";
const address = process.env.FAKE_WAAP_ADDRESS ?? "0x" + "a1".repeat(32);
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stdin = "";
if (args.includes("-") || scenario === "phone-2fa") {
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
}
if (process.env.FAKE_WAAP_LOG) {
  fs.appendFileSync(process.env.FAKE_WAAP_LOG, JSON.stringify({ args, stdin, at: Date.now() }) + "\n");
}

if (args[0] === "--version") {
  console.log(process.env.FAKE_WAAP_VERSION ?? "2.2.1");
  process.exit(0);
}
if (args[0] === "whoami") {
  if (scenario === "no-session") {
    out({ event: "error", code: "NO_SESSION", message: "No session found. Run `waap-cli login` first.", command: "whoami" });
    process.exit(2);
  }
  out({ event: "result", email: "agent@example.com", evmWalletAddress: "0x" + "e".repeat(40), suiWalletAddress: address });
  process.exit(0);
}
if (args[0] !== "send-tx") {
  out({ event: "error", code: "INVALID_PARAMS", message: `fake: unsupported ${args[0]}` });
  process.exit(3);
}

let digest = "FAKEdigest1111111111111111111111111111111111";

// Repair round 01: with FAKE_WORLD set, a broadcasting scenario applies the transaction's
// effect to the shared world file (see world.mjs); FAKE_WAAP_EFFECT selects how.
const BROADCASTS = new Set(["ok", "2fa-then-ok", "phone-2fa", "onchain-failed", "pending", "confirmation-error", "network-error", "other-sender", "kill-parent-after-send"]);
if (process.env.FAKE_WORLD && BROADCASTS.has(scenario) && !(scenario === "phone-2fa" && !/^\d{6}\s*$/.test(stdin))) {
  const world = await import("./world.mjs");
  const kindBase64 = args[args.indexOf("--tx") + 1];
  digest = world.withWorld(process.env.FAKE_WORLD, (w) => {
    w.sends = (w.sends ?? 0) + 1;
    const d = `FAKEdigest${String(w.sends).padStart(34, "0")}`;
    const mode = scenario === "onchain-failed" ? "failed" : (process.env.FAKE_WAAP_EFFECT ?? "apply");
    world.applySend(w, { kindBase64, sender: address, digest: d, mode });
    return d;
  });
}
if (process.env.FAKE_WAAP_BREAK_JOURNAL) fs.chmodSync(process.env.FAKE_WAAP_BREAK_JOURNAL, 0o400);
if (scenario === "kill-parent-after-send") {
  process.kill(process.ppid, "SIGKILL");
  process.exit(0);
}
const result = (extra) => out({ event: "result", from: address, txHash: digest, operationId: "cli:fake", ...extra });
switch (scenario) {
  case "ok":
    result({ status: "confirmed" });
    process.exit(0);
  case "2fa-then-ok":
    out({ event: "awaiting_2fa", method: "email_authz", payload_id: "p1", timeout_ms: 300000, confirm_url: "https://approve.example/p1" });
    await sleep(Number(process.env.FAKE_WAAP_DELAY_MS ?? 400));
    result({ status: "confirmed" });
    process.exit(0);
  case "phone-2fa": {
    out({ event: "awaiting_2fa", method: "phone_authz", payload_id: "p3", timeout_ms: 300000 });
    process.stdout.write("Enter the 6-digit code from your phone: ");
    if (/^\d{6}\s*$/.test(stdin)) {
      process.stdout.write("\n");
      result({ status: "confirmed" });
      process.exit(0);
    }
    process.stdout.write("\n");
    out({ event: "error", code: "TWO_FA_TIMEOUT", message: "no phone code entered" });
    process.exit(8);
  }
  case "onchain-failed":
    result({ status: "failed" });
    process.exit(0); // real waap-cli exits 0 here too (bundle function `wb`)
  case "pending":
    result({ status: "pending", pending: true });
    process.exit(0);
  case "confirmation-error":
    result({ status: "pending", confirmationError: "status endpoint unreachable" });
    process.exit(0);
  case "policy-rejected":
    out({ event: "error", code: "POLICY_REJECTED", message: "policy gate failed: HTTP 403" });
    process.exit(4);
  case "2fa-timeout":
    out({ event: "awaiting_2fa", method: "email_authz", payload_id: "p2", timeout_ms: 1000 });
    out({ event: "error", code: "TWO_FA_TIMEOUT", message: "approval timed out" });
    process.exit(8);
  case "insufficient-funds":
    out({ event: "error", code: "INSUFFICIENT_FUNDS", message: "insufficient gas" });
    process.exit(6);
  case "network-error":
    out({ event: "error", code: "NETWORK", message: "broadcast transport failed" });
    process.exit(7);
  case "garbage":
    console.log("not json at all");
    console.log("{ broken json");
    process.exit(0);
  case "other-sender":
    out({ event: "result", from: "0x" + "b2".repeat(32), txHash: digest, status: "confirmed" });
    process.exit(0);
  case "crash":
    process.stderr.write("fake: crashed\n");
    process.exit(1);
  default:
    out({ event: "error", code: "UNKNOWN", message: `unknown scenario ${scenario}` });
    process.exit(1);
}

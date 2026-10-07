#!/usr/bin/env node
// Applies one deliberate defect at a time and requires a named, declared target test to fail.
// Follow-up R2: errors/timeouts/signals/missing tests never count as kills; the unchanged
// positive control must pass before and after. Per-run JSON reports land in $MUTATION_OUT.
// The original is restored in `finally`, and its contents are verified after each mutant.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, readReport } from "./mutation-classify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MUTANTS = [
  ["src/inspect.ts", "if (!ALLOWED_SUILEND_CALLS.has(name)) fail", "if (false) fail", "allowlist disabled"],
  ["src/inspect.ts", "if (to !== owner) fail", "if (false) fail", "recipient check disabled"],
  ["src/inspect.ts", "if (amount !== plan.amountMist) fail", "if (false) fail", "split amount check disabled"],
  ["src/plan.ts", "if (o.borrowCount > 0) {", "if (false) {", "borrow refusal disabled"],
  ["src/plan.ts", "if (wallet.coinObjectMist < needed) {", "if (wallet.coinObjectMist + wallet.addressBalanceMist < needed) {", "address balance counted as spendable"],
  ["src/plan.ts", ".integerValue(BigNumber.ROUND_FLOOR)\n      .toFixed(0),\n  );\n}\n\nexport function chooseObligation", ".integerValue(BigNumber.ROUND_CEIL)\n      .toFixed(0),\n  );\n}\n\nexport function chooseObligation", "MIST→cToken rounds up"],
  ["src/waap.ts", 'if (result.status === "failed") return { kind: "failed"', 'if (result.status === "failed") return { kind: "confirmed"', "on-chain failure treated as success"],
  ["src/waap.ts", 'return ["send-tx", "--chain", WAAP_CHAIN, "--tx", kindBase64,', 'return ["send-tx", "--chain", WAAP_CHAIN, "--tx", "-",', "kind back on stdin (breaks phone 2FA)"],
  ["src/app.ts", "  if (allowPending) return;", "  return;", "pending-journal block disabled"],
  ["src/app.ts", "if (!skipSimulate) {", "if (false) {", "simulation gate disabled"],
  ["src/ptb.ts", "tx.splitCoins(tx.gas, [tx.pure.u64(plan.amountMist)])", "tx.splitCoins(tx.gas, [tx.pure.u64(plan.amountMist + 1n)])", "supply amount off by one MIST"],
  // Repair round 01 guards
  ["src/app.ts", "      r = await reconcile(port, rec);", "      r = { state: \"reconciled\" as const, report: {} };", "R1 success without chain readback"],
  ["src/app.ts", "if (outcome.from && !sameAddress(outcome.from, plan.owner)) {", "if (false) {", "R2 WaaP-reported sender check disabled"],
  ["src/reconcile.ts", "if (normalizeSuiAddress(tx.sender) !== owner) {", "if (false) {", "R2 on-chain sender check disabled"],
  ["src/reconcile.ts", "if (walletFlow <= 0n || (!ctx.withdrawAll", "if (false && (!ctx.withdrawAll", "R1 withdraw wallet-credit check disabled"],
  ["src/reconcile.ts", "if (added === 0n) return", "if (false) return", "R1 delayed supply treated as mismatch"],
  ["src/journal.ts", "if (bad.length > 0) {", "if (false) {", "R3 unreadable journal not reported as such"],
  ["src/journal.ts", "        if (!validate(JSON.parse(raw))) bad.push({ line: i + 1, raw });", "        JSON.parse(raw);", "R3 record schema validation disabled"],
  ["src/app.ts", "  const open = deps.journal.open(address); // reads (and validates) the journal even with --allow-pending\n", "  if (allowPending) return;\n  const open = deps.journal.open(address);\n", "R3 --allow-pending skips journal validation"],
  ["src/app.ts", "  if (!mutate) return fn();", "  if (true) return fn();", "R4 mutation lock disabled"],
  ["src/app.ts", "    deps.journal.update(lock, id, state, fields);\n  } catch (e) {", "    deps.journal.update(lock, id, state, fields);\n  } catch (e) {\n    throw e;", "A1 post-send write failure loses the digest"],
  ["src/app.ts", "  if (id !== MAINNET_CHAIN_ID) {", "  if (false) {", "A2 network check disabled"],
  ["src/cli.ts", "if (!OPEN_STATES.includes(rec.state)) {", "if (false) {", "A5 ack accepts closed records"],
  ["src/app.ts", "unresolved = lock ? await resolveOpen(deps, lock, port, address) : deps.journal.open(address);", "unresolved = await resolveOpen(deps, lock!, port, address);", "A4 status writes while another process holds the lock"],
  // Session 2
  ["src/lock.ts", "if (!lock?.info?.token || readLock(lockFile(dir))?.token !== lock.info.token) {", "if (false) {", "S1 journal writes without the held lock"],
  ["src/app.ts", "if (allowPending && unknown.length > 0) {", "if (false) {", "S2 --allow-pending bypasses unknown-outcome records"],
  ["src/app.ts", "    if (owner) {", "    if (false) {", "S3 digest reuse across records accepted"],
  ["src/chain.ts", "if (e instanceof TransactionError && e.reason === \"notFound\") return { status: \"not_found\" };", "return { status: \"not_found\" };", "S5 transport error read as not found"],
  ["src/chain.ts", "gasOwner: t.transaction.gasData.owner ?? sender,", "gasOwner: sender,", "S5 sponsored gas owner ignored"],
  // Follow-up
  ["src/app.ts", " || tx.kindSha256 !== rec.context.kindSha256 || !after) {", " || !after) {", "R1 user digest not bound to the planned kind"],
  ["src/app.ts", "    kindSha256: createHash(\"sha256\").update(Buffer.from(prepared.kindBase64, \"base64\")).digest(\"hex\"),", "    kindSha256: undefined,", "R1 planned kind hash not stored"],
  ["src/chain.ts", "const kind = bcs.TransactionKind.serialize(data.V1.kind).toBytes();", "const kind = txDataBcs;", "R1 live kind hash over the whole TransactionData"],
  // Follow-up 2
  // Retired in follow-up 3 as an EQUIVALENT mutant (survived as an equivalent mutant): with the per-submission nonce, a transaction carrying the
  // record's kind bytes can only be its own send, which follows the pre-send checkpoint read, so the
  // bound can never reject a transaction that passes the kind check. It stays as a filter only.
  // ["src/app.ts", "const after = ...", "const after = true;", "F2-R1 checkpoint bound disabled (kind equality alone)"],
  ["src/app.ts", "    checkpointBefore: checkpointBefore.toString(),\n", "", "F2-R1 checkpointBefore not stored"],
  ["src/chain.ts", "        checkpoint: t.checkpoint ? BigInt(t.checkpoint) : undefined,\n", "", "F2-R1 live checkpoint not parsed"],
  // Follow-up 3
  ["src/app.ts", "  const nonce = randomBytes(16);", "  const nonce = undefined;", "F3 no submission nonce (identical actions share kind bytes)"],
  ["src/app.ts", "    if (rec.context?.identity !== \"nonce-v1\" || !rec.context.kindSha256", "    if (!rec.context?.kindSha256", "F3 identity gate disabled (older records accepted by digest)"],
  ["src/app.ts", "    identity: \"nonce-v1\",\n", "", "F3 nonce identity not recorded"],
  ["src/inspect.ts", "if (Buffer.compare(Buffer.from(got), Buffer.from(nonce)) !== 0) fail(", "if (false) fail(", "F3 inspector accepts a different nonce"],
  ["test/fixtures/world.mjs", "      if (abandoned(lock)) {", "      if (false) {", "R2 fixture world lock not recoverable after SIGKILL (test-infrastructure control)"],
  ["test/fixtures/world.mjs", "  if (!Number.isInteger(pid) || pid <= 0) return Date.now() - st.mtimeMs > 2000;\n", "", "R2 fixture empty PID file read as pid 0 (test-infrastructure control)"],
];

/** Which tests each deliberate defect is meant to break. A kill counts only if a failing test matches. */
const TARGETS = {
  "allowlist disabled": /inspectKind .*(borrow call|different package)/,
  "recipient check disabled": /inspectKind .*sent to someone else/,
  "split amount check disabled": /inspectKind .*different split amount/,
  "borrow refusal disabled": /plan\.test.*(E9|borrows)/,
  "address balance counted as spendable": /plan\.test.*E4/,
  "MIST→cToken rounds up": /plan\.test.*(cToken|E12)/,
  "on-chain failure treated as success": /waap\.test.*onchain-failed/,
  "kind back on stdin (breaks phone 2FA)": /waap\.test.*(literal --tx|phone 2FA)/,
  "pending-journal block disabled": /(E26|blocks the next submission|restart is blocked|exit 8)/,
  "simulation gate disabled": /A2 simulation failure/,
  "supply amount off by one MIST": /(ptb\.test.*first supply|supply --yes submits the exact)/,
  "R1 success without chain readback": /F1 completion.*nothing on chain/,
  "R2 WaaP-reported sender check disabled": /WaaP reports another sender|E24/,
  "R2 on-chain sender check disabled": /chain shows another sender|wrong signer on chain/,
  "R1 withdraw wallet-credit check disabled": /wallet not c/,
  "R1 delayed supply treated as mismatch": /objects lagging/,
  "R3 unreadable journal not reported as such": /F3 .*truncated|truncated journal/,
  "R3 record schema validation disabled": /F3 .*invalid state/,
  "R3 --allow-pending skips journal validation": /truncated journal: every command exits 10|F3 /,
  "R4 mutation lock disabled": /F4 |two concurrent|--allow-pending does not bypass the lock/,
  "A1 post-send write failure loses the digest": /A1 |journal unwritable after send/,
  "A2 network check disabled": /A2 the read node|wrong network/,
  // run 1 declared only /journal list\/ack/ (wrong: that test acks an open record); corrected after run 1, see 03a
  "A5 ack accepts closed records": /journal list\/ack|ack is audited/,
  "A4 status writes while another process holds the lock": /\(A4\) status does not write/,
  "S1 journal writes without the held lock": /S1: /,
  "S2 --allow-pending bypasses unknown-outcome records": /S2: .*(submitting|pending)|does not override a pending/,
  "S3 digest reuse across records accepted": /S3: /,
  "S5 transport error read as not found": /grpc-reads.*6\. transport errors/,
  "S5 sponsored gas owner ignored": /grpc-reads.*4\. sponsored gas/,
  // follow-up 2: with the checkpoint bound, the kind check is isolated by the DIFFERENT-kind-after test
  "R1 user digest not bound to the planned kind": /DIFFERENT-kind failed tx/,
  "R1 planned kind hash not stored": /R1: .*positive control/,
  "R1 live kind hash over the whole TransactionData": /grpc-reads.*7\. kindSha256/,
  "F2-R1 checkpointBefore not stored": /(follow-up 2 R1|R1: only the submission).*positive control/,
  "F2-R1 live checkpoint not parsed": /grpc-reads.*8\. latestCheckpoint/,
  "F3 no submission nonce (identical actions share kind bytes)": /follow-up 3 R1: .*historical identical|two plans for the same action/,
  "F3 identity gate disabled (older records accepted by digest)": /older format/,
  "F3 nonce identity not recorded": /follow-up 3 R1: .*control/,
  "F3 inspector accepts a different nonce": /rejects a different nonce/,
  "R2 fixture world lock not recoverable after SIGKILL (test-infrastructure control)": /R2: /,
  "R2 fixture empty PID file read as pid 0 (test-infrastructure control)": /R2: .*empty PID/,
};

const CONTROL_REPEATS = Number(process.env.CONTROL_REPEATS ?? 3);
const TIMEOUT_MS = 10 * 60_000;
const outDir = process.env.MUTATION_OUT ?? path.join(root, ".test-tmp", "mutation");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/** One vitest run with the JSON reporter: spawn outcome plus the parsed report (if any). */
function runSuite(tag) {
  const json = path.join(outDir, `${tag}.json`);
  const r = spawnSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${json}`], { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS });
  fs.writeFileSync(path.join(outDir, `${tag}.stderr`), r.stderr ?? "");
  let report;
  try {
    report = JSON.parse(fs.readFileSync(json, "utf8"));
  } catch {}
  return { status: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", error: r.error?.code, report };
}
const testRoot = path.join(root, "test");

const results = [];
let bad = 0;
const record = (o) => {
  results.push(o);
  console.log(`${o.verdict.padEnd(9)} ${o.label}` + (o.matched?.length ? `\n            caught by: ${o.matched.join("\n                       ")}` : "") + (o.note ? `\n            ${o.note}` : ""));
};

// Positive control first: exit 0, all tests run and passed. Its test identities are the reference set.
const control0 = runSuite("control-0");
const c0 = classify(control0, { testRoot });
if (c0.verdict !== "PASS") {
  record({ label: "positive control (unchanged sources)", verdict: "BAD", note: `${c0.verdict}: ${c0.note}` });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results, null, 1));
  console.log("\nPositive control failed; no mutant can be judged.");
  process.exit(1);
}
const controlIds = new Set(readReport(control0.report, testRoot).tests.keys());
record({ label: `positive control (unchanged sources): ${controlIds.size}/${controlIds.size} passed`, verdict: "OK", status: control0.status });

const backupDir = path.join(root, ".test-tmp", "mutation-backup");
fs.mkdirSync(backupDir, { recursive: true });
MUTANTS.forEach(([rel, from, to, label], i) => {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(backupDir, path.basename(rel)), original);
  const target = TARGETS[label];
  if (!target) return void (bad++, record({ label, verdict: "ERROR", note: "no declared target tests" }));
  if (!original.includes(from)) return void (bad++, record({ label, verdict: "ERROR", note: `pattern not found in ${rel}` }));
  try {
    fs.writeFileSync(file, original.replace(from, to));
    const run = runSuite(`mutant-${String(i + 1).padStart(2, "0")}`);
    const c = classify(run, { controlIds, target, testRoot });
    const verdict = c.verdict === "PASS" ? "SURVIVED" : c.verdict;
    if (verdict !== "KILLED") bad++;
    record({ label, file: rel, verdict, matched: c.matched, note: c.note, failed: c.failed, status: run.status, signal: run.signal });
  } finally {
    fs.writeFileSync(file, original);
    if (fs.readFileSync(file, "utf8") !== original) throw new Error(`restore failed for ${rel}`);
  }
});

// Repeat the positive control after all mutants (stability of the unchanged suite).
for (let k = 1; k <= CONTROL_REPEATS; k++) {
  const c = classify(runSuite(`control-${k}`), { controlIds, testRoot });
  const ok = c.verdict === "PASS";
  if (!ok) bad++;
  record({ label: `positive control repeat ${k}`, verdict: ok ? "OK" : "BAD", note: `${c.verdict}: ${c.note}` });
}
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(results, null, 1));
console.log(bad ? `\n${bad} problem(s)` : `\nAll ${MUTANTS.length} mutants killed by their declared target tests; positive control passed ${CONTROL_REPEATS + 1}×; sources restored.`);
process.exit(bad ? 1 : 0);

#!/usr/bin/env node
// Runs the REAL installed @human.tech/waap-cli for local-only commands (--version, commands --json)
// under a network trap with an empty, throwaway session dir, and asserts that every command and
// flag this recipe depends on exists. Never logs in, signs or contacts a service.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = require("@human.tech/waap-cli/package.json");
const bin = path.join(path.dirname(require.resolve("@human.tech/waap-cli/package.json")), "dist", "index.js");
const work = path.join(root, ".test-tmp", "contract");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, "session"), { recursive: true });
const trapLog = path.join(work, "net-trap.log");
const env = {
  PATH: process.env.PATH,
  HOME: work, // keep any accidental default-path writes inside the workspace
  WAAP_CLI_SESSION_DIR: path.join(work, "session"),
  NET_TRAP_LOG: trapLog,
};
const run = (args) => {
  const r = spawnSync(process.execPath, ["--import", path.join(root, "test/fixtures/net-trap.mjs"), bin, ...args], { env, encoding: "utf8" });
  return { args, status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); };

console.log(`waap-cli package ${pkg.name}@${pkg.version} at ${bin}`);
const v = run(["--version"]);
console.log(`$ waap-cli --version → exit ${v.status}: ${v.stdout.trim()}`);
check(v.status === 0 && v.stdout.trim() === "2.2.1", "--version is 2.2.1");

const c = run(["commands", "--json"]);
console.log(`$ waap-cli commands --json → exit ${c.status}, ${c.stdout.length} bytes`);
if (c.stderr.trim()) console.log(`stderr: ${c.stderr.trim().slice(0, 500)}`);
let schema;
try {
  schema = JSON.parse(c.stdout.trim().split("\n").filter(Boolean).at(-1));
} catch (e) {
  check(false, `commands --json output parses as JSON (${e.message})`);
}
if (schema) {
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(root, "evidence", "waap-cli-2.2.1-commands.json"), JSON.stringify(schema, null, 2));
  check(schema.event === "result", "schema is a single NDJSON result event");
  const cmds = schema.commands ?? schema.result?.commands ?? [];
  const find = (p) => cmds.find((x) => (Array.isArray(x.path) ? x.path.join(" ") : x.path ?? x.name) === p);
  const flagsOf = (cmd) => (cmd?.options ?? []).map((o) => o.long ?? o.flags ?? o.name).join(" ");
  const sendTx = find("send-tx");
  check(!!sendTx, "send-tx command exists");
  for (const f of ["--chain", "--tx", "--tx-format", "--wait"]) check(flagsOf(sendTx).includes(f), `send-tx has ${f}`);
  check(sendTx?.authentication === "signing", "send-tx is a signing command");
  const fmt = (sendTx?.options ?? []).find((o) => o.long === "--tx-format");
  check(/Sui: json\|base64/.test(fmt?.description ?? ""), "send-tx --tx-format accepts base64 for Sui");
  const whoami = find("whoami");
  check(!!whoami, "whoami command exists");
  check((schema.globalOptions ?? []).some((o) => o.long === "--json"), "--json global option exists");
  check(schema.cli?.version === "2.2.1", "schema reports cli version 2.2.1");
}

const attempts = fs.existsSync(trapLog) ? fs.readFileSync(trapLog, "utf8").trim().split("\n").filter(Boolean) : [];
check(attempts.length === 0, `no outbound network attempts (recorded: ${attempts.length})`);
if (attempts.length) console.log(attempts.join("\n"));
const sessionFiles = fs.readdirSync(path.join(work, "session"));
check(sessionFiles.length === 0, `session dir untouched (${sessionFiles.join(",") || "empty"})`);
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL CONTRACT CHECKS PASSED");
process.exit(failures.length ? 1 : 0);

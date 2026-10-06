// Repair round 01: run one recipe command in its own OS process against the shared world file
// and fake waap-cli. Test harness only; production code has no path to it.
//   argv[2] = JSON { mode: "command" | "main", command?, opts?, argv?, stateDir, world, scenario?, effect? }
import path from "node:path";
import { Journal } from "../../src/journal.js";
import * as app from "../../src/app.js";
import { worldChain } from "../world-chain.js";
import { FAKE_WAAP, OWNER } from "../helpers.js";

// Outbound network is trapped in these child processes too (same trap as test/setup.ts).
process.env.NET_TRAP_LOG ??= new URL("../../.test-tmp/net-trap.log", import.meta.url).pathname;
await import("./net-trap.mjs");

const spec = JSON.parse(process.argv[2]);
// Harness-level knobs (e.g. FAKE_BARRIER_DIR) must reach this process's fake chain too.
Object.assign(process.env, spec.env ?? {});
const env = {
  ...process.env,
  FAKE_WAAP_SCENARIO: spec.scenario ?? "ok",
  FAKE_WAAP_ADDRESS: OWNER,
  FAKE_WORLD: spec.world,
  FAKE_WAAP_LOG: path.join(path.dirname(spec.world), "waap-calls.jsonl"),
  ...(spec.effect ? { FAKE_WAAP_EFFECT: spec.effect } : {}),
  ...(spec.env ?? {}),
};
const chain = worldChain(spec.world);
// Follow-up 3 (ported from the reviewer's reviewer-run-command.ts): an external read substitute
// where this node's checkpoint height is `checkpointLag` behind when read. Nothing else changes.
if (spec.checkpointLag) {
  const original = chain.port.latestCheckpoint.bind(chain.port);
  chain.port.latestCheckpoint = async () => (await original()) - BigInt(spec.checkpointLag);
}
const waap = { command: [process.execPath, FAKE_WAAP], env, childStdin: "ignore" as const };

if (spec.mode === "main") {
  const { main } = await import("../../src/cli.js");
  const code = await (main as any)(spec.argv, { ...env, SUILEND_WAAP_STATE_DIR: spec.stateDir }, {
    chain: chain.deps,
    waap,
    reconcile: { attempts: 3, delayMs: 20 },
  });
  process.exitCode = code;
} else {
  const deps: any = {
    chain: chain.deps,
    waap,
    journal: new Journal(spec.stateDir),
    reporter: { progress: () => {}, event: () => {} },
    reconcile: { attempts: 3, delayMs: 20 },
  };
  const fn = (app as any)[`${spec.command}Command`];
  try {
    const value = await fn(deps, spec.opts ?? {});
    console.log(JSON.stringify({ ok: true, value }, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
    process.exitCode = 1;
  }
}

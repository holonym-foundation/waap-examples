#!/usr/bin/env node
// Repair round 01: repeat the two-process race N times through the real CLI main() with a
// barrier that holds the first process inside its locked section until the second has started
// (or 3 s pass). Counts waap-cli sends per round. Pass: every round sends exactly once and the
// other process exits 9 (LOCKED). Usage: node scripts/race-loop.mjs [rounds=20]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newWorld, writeWorld } from "../test/fixtures/world.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = path.join(root, "test", "fixtures", "run-command.ts");
const rounds = Number(process.argv[2] ?? 20);
const base = path.join(root, ".test-tmp", `race-loop-${Date.now()}`);

const run = (spec) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: root });
    c.on("exit", (code) => resolve(code));
  });

let bad = 0;
const pairs = [["supply", "supply"], ["supply", "withdraw"], ["withdraw", "withdraw"]];
for (let i = 0; i < rounds; i++) {
  const dir = path.join(base, String(i));
  fs.mkdirSync(dir, { recursive: true });
  const world = path.join(dir, "world.json");
  writeWorld(world, newWorld());
  const env = { FAKE_BARRIER_DIR: path.join(dir, "barrier"), FAKE_BARRIER_N: "2" };
  const [a, b] = pairs[i % pairs.length];
  const argv = (cmd) => [cmd, "--amount", "1", "--yes", "--json"];
  const codes = await Promise.all([
    run({ mode: "main", argv: argv(a), stateDir: path.join(dir, "state"), world, env }),
    run({ mode: "main", argv: argv(b), stateDir: path.join(dir, "state"), world, env }),
  ]);
  const log = path.join(dir, "waap-calls.jsonl");
  const sends = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"send-tx"')).length : 0;
  const ok = sends === 1 && [...codes].sort().join(",") === "0,9";
  if (!ok) bad++;
  console.log(`round ${String(i + 1).padStart(2)} ${a.padEnd(8)} vs ${b.padEnd(8)} exit codes ${codes.join(",")}  sends ${sends}  ${ok ? "OK" : "BAD"}`);
}
console.log(bad ? `\n${bad}/${rounds} bad round(s)` : `\nAll ${rounds} rounds: exactly one send, loser exited 9 (LOCKED).`);
process.exit(bad ? 1 : 0);

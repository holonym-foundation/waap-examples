// Follow-up: R1 and R2 at the process boundary.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HERE, OWNER, readLog, tmpDir } from "./helpers.js";
import { Journal } from "../src/journal.js";
// @ts-expect-error untyped fixture module
import { newWorld, readWorld, writeWorld } from "./fixtures/world.mjs";

const ROOT = path.join(HERE, "..");
const RUN = path.join(HERE, "fixtures", "run-command.ts");

function world() {
  const dir = tmpDir("fu-");
  const file = path.join(dir, "world.json");
  writeWorld(file, newWorld());
  const stateDir = path.join(dir, "state");
  const sends = () => readLog(path.join(dir, "waap-calls.jsonl")).filter((c) => c.args[0] === "send-tx");
  return { dir, file, stateDir, sends, read: () => readWorld(file), journal: () => new Journal(stateDir) };
}
type W = ReturnType<typeof world>;
interface Run {
  code: number | null;
  events: any[];
  stderr: string;
}
function main(w: W, argv: string[], opts: { scenario?: string; effect?: string } = {}): Promise<Run> {
  const spec = { mode: "main", argv: [...argv, "--json"], stateDir: w.stateDir, world: w.file, ...opts };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) =>
      resolve({ code, stderr, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }),
    );
  });
}
const result = (r: Run) => r.events.find((e) => e.event === "result");

/** Unknown submission: waap-cli sent, the recipe was killed before saving the digest; stale lock cleared. */
async function unknownSubmission(w: W, effect?: string) {
  const k = await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "kill-parent-after-send", ...(effect ? { effect } : {}) });
  expect(k.code === 0).toBe(false);
  expect((await main(w, ["journal", "unlock"])).code).toBe(0);
  const [rec] = w.journal().open();
  expect(rec).toMatchObject({ state: "submitting" });
  const digest = Object.keys(w.read().txs)[0];
  return { rec, digest };
}

describe("R1: only the submission's own transaction can close it", () => {
  it("unrelated failed digest by the same owner: exit 11, record stays open, next supply blocked, one send", async () => {
    const w = world();
    const { rec } = await unknownSubmission(w);
    const ww = w.read();
    ww.txs.UNRELATED_OLD_FAILED = { status: "failure", sender: OWNER, gasOwner: OWNER, gasMist: "2000000", suiChange: { [OWNER]: "-2000000" } };
    writeWorld(w.file, ww);
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", "UNRELATED_OLD_FAILED"]);
    expect(r.code).toBe(11);
    expect(w.journal().open().map((x) => x.id)).toEqual([rec.id]);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    expect(w.sends()).toHaveLength(1);
  });

  it("positive control: the correct digest still reconciles (success)", async () => {
    const w = world();
    const { rec, digest } = await unknownSubmission(w);
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", digest]);
    expect(r.code).toBe(0);
    expect(result(r)).toMatchObject({ outcome: "reconciled", digest });
  });

  it("positive control: the correct digest of a confirmed on-chain failure closes it as failed (exit 6)", async () => {
    const w = world();
    const { rec, digest } = await unknownSubmission(w, "failed");
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", digest]);
    expect(r.code).toBe(6);
    expect(w.journal().latest().find((x) => x.id === rec.id)?.state).toBe("failed");
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(0);
    expect(w.sends()).toHaveLength(2);
  });
});

describe("R2: an interrupted fixture world lock is recoverable", () => {
  // Follow-up 2: ported from ../reviewer-followup-2026-10-04/assembly/reviewer-lock-kill.mjs — a real
  // holder is SIGKILLed while inside the fixture lock, then status runs in a new process.
  it("holder SIGKILLed inside withWorld: restarted status completes and the abandoned lock is removed", async () => {
    const w = world();
    const held = path.join(w.dir, "held");
    const fixture = new URL("./fixtures/world.mjs", import.meta.url).href;
    const holder = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import {withWorld} from ${JSON.stringify(fixture)}; import fs from "node:fs";` +
        `withWorld(${JSON.stringify(w.file)}, () => { fs.writeFileSync(${JSON.stringify(held)}, "held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); });`,
    ]);
    const closed = new Promise<{ signal: string | null }>((r) => holder.on("close", (_c, signal) => r({ signal })));
    for (let i = 0; i < 500 && !fs.existsSync(held); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(held), "holder never reached the lock boundary").toBe(true);
    holder.kill("SIGKILL");
    expect((await closed).signal).toBe("SIGKILL");
    expect(fs.existsSync(`${w.file}.lock`)).toBe(true);
    const st = await main(w, ["status"]);
    expect(st.code, st.stderr.slice(0, 500)).toBe(0);
    expect(fs.existsSync(`${w.file}.lock`)).toBe(false);
  });

  it("abandoned world.json.lock with an empty PID file (killed mid-write): status still completes", async () => {
    const w = world();
    const lock = `${w.file}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const st = await main(w, ["status"]);
    expect(st.code, st.stderr.slice(0, 500)).toBe(0);
    expect(result(st).unresolvedSubmissions).toEqual([]);
  });

  it("abandoned world.json.lock (holder killed): status still completes", async () => {
    const w = world();
    const lock = `${w.file}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "999999"); // a dead holder
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const st = await main(w, ["status"]);
    expect(st.code, st.stderr.slice(0, 500)).toBe(0);
    expect(result(st).unresolvedSubmissions).toEqual([]);
  });
});

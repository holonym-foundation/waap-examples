// Session 2: S1–S4 regressions.
// S2–S4 run the real CLI `main()` in separate OS processes, like test/process.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HERE, readLog, tmpDir } from "./helpers.js";
import { Journal } from "../src/journal.js";
import { acquireLock } from "../src/lock.js";
// @ts-expect-error untyped fixture module
import { newWorld, readWorld, writeWorld } from "./fixtures/world.mjs";

const ROOT = path.join(HERE, "..");
const RUN = path.join(HERE, "fixtures", "run-command.ts");

function world(overrides: Record<string, unknown> = {}) {
  const dir = tmpDir("s2-");
  const file = path.join(dir, "world.json");
  writeWorld(file, newWorld(overrides));
  const stateDir = path.join(dir, "state");
  const sends = () => readLog(path.join(dir, "waap-calls.jsonl")).filter((c) => c.args[0] === "send-tx");
  return { dir, file, stateDir, sends, read: () => readWorld(file), journal: () => new Journal(stateDir) };
}
type W = ReturnType<typeof world>;
interface Run {
  code: number | null;
  events: any[];
}
function main(w: W, argv: string[], opts: { scenario?: string; effect?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const spec = { mode: "main", argv: [...argv, "--json"], stateDir: w.stateDir, world: w.file, ...opts };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: ROOT });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) =>
      resolve({ code, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }),
    );
  });
}
const result = (r: Run) => r.events.find((e) => e.event === "result");
const error = (r: Run) => r.events.find((e) => e.event === "error");

/** Leave an open `submitting` record with no digest (process killed after waap-cli sent), lock cleared. */
async function killedAfterSend(w: W) {
  const k = await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "kill-parent-after-send" });
  expect(k.code === 0).toBe(false);
  expect((await main(w, ["journal", "unlock"])).code).toBe(0);
  const [rec] = w.journal().open();
  expect(rec).toMatchObject({ state: "submitting" });
  return rec;
}

describe("S1: journal writes require the held mutation lock (reviewer held-out case 2)", () => {
  it("two Journal objects on one store cannot both open a submission without the lock", () => {
    const dir = tmpDir("s2-raw-");
    const a = new Journal(dir);
    const b = new Journal(dir);
    expect(a.open()).toHaveLength(0);
    expect(b.open()).toHaveLength(0);
    expect(() => (a as any).start({ action: "supply", address: "0x1" })).toThrow(/lock/i);
    expect(() => (b as any).start({ action: "supply", address: "0x1" })).toThrow(/lock/i);
    expect(a.open()).toHaveLength(0);
  });

  it("a lock handle that no longer owns mutation.lock is refused; the owner's handle works", () => {
    const dir = tmpDir("s2-raw-");
    const j = new Journal(dir);
    const held = acquireLock(dir, "test");
    const id = j.start(held, { action: "supply", address: "0x1" });
    expect(j.open()).toHaveLength(1);
    held.release();
    expect(() => j.update(held, id, "pending")).toThrow(/lock/i);
    const other = acquireLock(dir, "test2");
    expect(() => j.start(held, { action: "supply", address: "0x1" })).toThrow(/lock/i);
    j.update(other, id, "acknowledged");
    other.release();
    expect(j.open()).toHaveLength(0);
  });
});

describe("S2: --allow-pending never bypasses a submission whose outcome is unknown", () => {
  it("open `submitting` record + --allow-pending: exit 8, no second send", async () => {
    const w = world();
    await killedAfterSend(w);
    const r = await main(w, ["supply", "--amount", "1", "--yes", "--allow-pending"]);
    expect(r.code).toBe(8);
    expect(w.sends()).toHaveLength(1);
  });

  it("open `pending` record (WaaP outcome unknown) + --allow-pending: exit 8, no second send", async () => {
    const w = world();
    expect((await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "pending" })).code).toBe(7);
    const r = await main(w, ["supply", "--amount", "1", "--yes", "--allow-pending"]);
    expect(r.code).toBe(8);
    expect(w.sends()).toHaveLength(1);
  });

  it("open `mismatch` record (digest known, effect differs) + --allow-pending: a new send is allowed", async () => {
    const w = world();
    expect((await main(w, ["supply", "--amount", "1", "--yes"], { effect: "wrong-sender" })).code).toBe(11);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    const r = await main(w, ["supply", "--amount", "1", "--yes", "--allow-pending"]);
    expect(r.code).toBe(0);
    expect(w.sends()).toHaveLength(2);
  });
});

describe("S3: a digest closes at most one journal record", () => {
  it("journal reconcile with a digest already attached to another record is refused", async () => {
    const w = world();
    const first = await main(w, ["supply", "--amount", "1", "--yes"]);
    expect(first.code).toBe(0);
    const d1 = result(first).digest;
    const rec = await killedAfterSend(w); // this second supply did land on chain
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", d1]);
    expect(r.code).toBe(2);
    expect(error(r).message).toMatch(/already/);
    expect(w.journal().open()).toHaveLength(1);
    const d2 = Object.keys(w.read().txs).find((d) => d !== d1)!;
    expect((await main(w, ["journal", "reconcile", rec.id, "--digest", d2])).code).toBe(0);
  });
});

describe("S4: a partly written lock file is never treated as stale", () => {
  it("empty mutation.lock: supply sends nothing, unlock refuses, status reports a mutation in progress", async () => {
    const w = world();
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(path.join(w.stateDir, "mutation.lock"), "");
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(9);
    expect((await main(w, ["supply", "--amount", "1", "--yes", "--allow-pending"])).code).toBe(9);
    expect((await main(w, ["journal", "unlock"])).code).toBe(9);
    expect(fs.existsSync(path.join(w.stateDir, "mutation.lock"))).toBe(true);
    const st = await main(w, ["status"]);
    expect(st.code).toBe(0);
    expect(result(st)).toMatchObject({ mutationInProgress: true });
    expect(w.sends()).toHaveLength(0);
  });

  it("lock written by another host is not removable by unlock", async () => {
    const w = world();
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(w.stateDir, "mutation.lock"),
      JSON.stringify({ pid: 999999, host: `not-${os.hostname()}`, token: "t", startedAt: "x", command: "supply 1" }),
    );
    expect((await main(w, ["journal", "unlock"])).code).toBe(9);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(9);
    expect(w.sends()).toHaveLength(0);
  });
});

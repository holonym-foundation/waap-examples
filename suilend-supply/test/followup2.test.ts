// Follow-up 2: submission identity for manual recovery.
// Ported from ../reviewer-followup-2026-10-04/assembly/reviewer-same-kind-regression.mjs.
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HERE, readLog, tmpDir } from "./helpers.js";
import { Journal } from "../src/journal.js";
// @ts-expect-error untyped fixture module
import { newWorld, readWorld, writeWorld } from "./fixtures/world.mjs";

const ROOT = path.join(HERE, "..");
const RUN = path.join(HERE, "fixtures", "run-command.ts");

function world() {
  const dir = tmpDir("fu2-");
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
}
function main(w: W, argv: string[], opts: { scenario?: string; effect?: string; stateDir?: string } = {}): Promise<Run> {
  const spec = { mode: "main", argv: [...argv, "--json"], stateDir: opts.stateDir ?? w.stateDir, world: w.file, scenario: opts.scenario, effect: opts.effect };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: ROOT });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }));
  });
}
const kindOf = (c: { args: string[] }) => c.args[c.args.indexOf("--tx") + 1];

/** A same-kind supply executed earlier from another state directory, then an unknown current one. */
async function historyThenUnknown(w: W, historyEffect: string) {
  const h = await main(w, ["supply", "--amount", "1", "--yes"], { stateDir: path.join(w.dir, "historical-state"), effect: historyEffect });
  const historical = Object.keys(w.read().txs)[0];
  const k = await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "kill-parent-after-send" });
  expect(k.code === 0).toBe(false);
  expect((await main(w, ["journal", "unlock"])).code).toBe(0);
  expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8); // guard control
  const [rec] = w.journal().open();
  const current = Object.keys(w.read().txs).find((d) => d !== historical)!;
  const [s1, s2] = w.sends();
  // Follow-up 3 migration: this premise was "identical kind bytes". Each submission now carries a
  // random nonce, so the kinds differ only by it; the behavioural assertions below are unchanged.
  expect(kindOf(s1)).not.toBe(kindOf(s2));
  return { h, historical, current, rec };
}

describe("follow-up 2 R1: a same-kind historical transaction is not this submission", () => {
  it("historical FAILED same-kind tx: reconcile exits 11, record stays open, next supply blocked; two sends total", async () => {
    const w = world();
    const { h, historical, rec } = await historyThenUnknown(w, "failed");
    expect(h.code).toBe(6);
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", historical]);
    expect(r.code).toBe(11);
    expect(w.journal().open().map((x) => x.id)).toEqual([rec.id]);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    expect(w.sends()).toHaveLength(2);
  });

  it("historical SUCCESSFUL same-kind tx is also refused (exit 11)", async () => {
    const w = world();
    const { h, historical, rec } = await historyThenUnknown(w, "apply");
    expect(h.code).toBe(0);
    expect((await main(w, ["journal", "reconcile", rec.id, "--digest", historical])).code).toBe(11);
    expect(w.journal().open()).toHaveLength(1);
  });

  it("positive control: the actual current digest still reconciles after a same-kind history", async () => {
    const w = world();
    const { current, rec } = await historyThenUnknown(w, "failed");
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", current]);
    expect(r.code).toBe(0);
    expect(r.events.find((e) => e.event === "result")).toMatchObject({ outcome: "reconciled", digest: current });
  });

  it("a DIFFERENT-kind failed tx by the same owner executed AFTER the record opened is refused (exit 11)", async () => {
    const w = world();
    const k = await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "kill-parent-after-send" });
    expect(k.code === 0).toBe(false);
    expect((await main(w, ["journal", "unlock"])).code).toBe(0);
    const [rec] = w.journal().open();
    const before = new Set(Object.keys(w.read().txs));
    // a later, different action by the same owner from another state directory, failed on chain
    expect((await main(w, ["supply", "--amount", "2", "--yes"], { stateDir: path.join(w.dir, "other-state"), effect: "failed" })).code).toBe(6);
    const later = Object.keys(w.read().txs).find((d) => !before.has(d))!;
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", later]);
    expect(r.code).toBe(11);
    expect(w.journal().open().map((x) => x.id)).toEqual([rec.id]);
  });
});

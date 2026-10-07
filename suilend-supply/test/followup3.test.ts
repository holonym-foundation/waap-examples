// Follow-up 3: manual recovery must identify the
// submission itself, also when the pre-send checkpoint read lags. Ported and extended from
// ../reviewer-followup2-2026-10-04/assembly/reviewer-lagged-checkpoint.mjs.
import fs from "node:fs";
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
  const dir = tmpDir("fu3-");
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
type Opts = { scenario?: string; effect?: string; stateDir?: string; checkpointLag?: number };
function main(w: W, argv: string[], o: Opts = {}): Promise<Run> {
  const spec = { mode: "main", argv: [...argv, "--json"], stateDir: o.stateDir ?? w.stateDir, world: w.file, scenario: o.scenario, effect: o.effect, checkpointLag: o.checkpointLag };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: ROOT });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }));
  });
}
const newDigests = (w: W, before: Set<string>) => Object.keys(w.read().txs).filter((d) => !before.has(d));

/**
 * Historical identical action (from another store, `historyEffect`), then the current one with a
 * lagged pre-send checkpoint read, killed before its digest is saved. Returns both digests.
 */
async function laggedUnknown(w: W, action: string[], historyEffect: string, currentEffect?: string) {
  const t0 = new Set(Object.keys(w.read().txs));
  await main(w, [...action, "--yes"], { stateDir: path.join(w.dir, "historical-state"), effect: historyEffect });
  const [historical] = newDigests(w, t0);
  expect(historical).toBeDefined();
  const t1 = new Set(Object.keys(w.read().txs));
  const k = await main(w, [...action, "--yes"], { scenario: "kill-parent-after-send", checkpointLag: 1, ...(currentEffect ? { effect: currentEffect } : {}) });
  expect(k.code === 0).toBe(false);
  const [current] = newDigests(w, t1);
  expect((await main(w, ["journal", "unlock"])).code).toBe(0);
  expect((await main(w, [...action, "--yes"])).code).toBe(8); // guard control
  const [rec] = w.journal().open();
  // the premise of the reviewer case: the lagged read does not exclude the historical transaction
  expect(BigInt(w.read().txs[historical].checkpoint)).toBeGreaterThan(BigInt(rec.context!.checkpointBefore!));
  return { rec, historical, current };
}

describe("follow-up 3 R1: lagged checkpoint read (reviewer case)", () => {
  it("supply: historical identical FAILED tx cannot close the lagged unknown submission; supply stays blocked", async () => {
    const w = world();
    const { rec, historical } = await laggedUnknown(w, ["supply", "--amount", "1"], "failed");
    const r = await main(w, ["journal", "reconcile", rec.id, "--digest", historical]);
    expect(r.code).toBe(11);
    expect(w.journal().open().map((x) => x.id)).toEqual([rec.id]);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    expect(w.sends()).toHaveLength(2);
  });

  it("supply: historical identical SUCCESSFUL tx is also refused", async () => {
    const w = world();
    const { rec, historical } = await laggedUnknown(w, ["supply", "--amount", "1"], "apply");
    expect((await main(w, ["journal", "reconcile", rec.id, "--digest", historical])).code).toBe(11);
    expect(w.journal().open()).toHaveLength(1);
  });

  it("withdraw: historical identical FAILED tx cannot close the lagged unknown withdraw", async () => {
    const w = world();
    const { rec, historical } = await laggedUnknown(w, ["withdraw", "--amount", "1"], "failed");
    expect((await main(w, ["journal", "reconcile", rec.id, "--digest", historical])).code).toBe(11);
    expect((await main(w, ["withdraw", "--amount", "1", "--yes"])).code).toBe(8);
  });

  it("control: the actual successful transaction still reconciles under lag (supply and withdraw)", async () => {
    for (const action of [["supply", "--amount", "1"], ["withdraw", "--amount", "1"]]) {
      const w = world();
      const { rec, current } = await laggedUnknown(w, action, "failed");
      const r = await main(w, ["journal", "reconcile", rec.id, "--digest", current]);
      expect(r.code, action.join(" ")).toBe(0);
      expect(r.events.find((e) => e.event === "result")).toMatchObject({ outcome: "reconciled", digest: current });
    }
  });

  it("control: the actual confirmed-FAILED transaction closes it as failed under lag; a new send then works", async () => {
    const w = world();
    const { rec, current } = await laggedUnknown(w, ["supply", "--amount", "1"], "apply", "failed");
    expect((await main(w, ["journal", "reconcile", rec.id, "--digest", current])).code).toBe(6);
    expect(w.journal().latest().find((x) => x.id === rec.id)?.state).toBe("failed");
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(0);
  });
});

describe("follow-up 3: adjacent recovery paths", () => {
  it("a record without a submission nonce (older format) cannot be closed by any digest, even its own", async () => {
    const w = world();
    const k = await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "kill-parent-after-send" });
    expect(k.code === 0).toBe(false);
    expect((await main(w, ["journal", "unlock"])).code).toBe(0);
    const [current] = Object.keys(w.read().txs);
    // rewrite the record's context as a follow-up-2 record (kind hash + checkpoint, no nonce identity)
    const jf = path.join(w.stateDir, "journal.jsonl");
    const lines = fs.readFileSync(jf, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    delete lines[0].context.identity;
    fs.writeFileSync(jf, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const [rec] = w.journal().open();
    expect((await main(w, ["journal", "reconcile", rec.id, "--digest", current])).code).toBe(11);
    expect(w.journal().open()).toHaveLength(1);
    // the audited override remains the way out
    expect((await main(w, ["journal", "ack", rec.id])).code).toBe(0);
  });

  it("two plans for the same action produce different kind bytes (the nonce)", async () => {
    const w = world();
    const a = await main(w, ["supply", "--amount", "1"]);
    const b = await main(w, ["supply", "--amount", "1"]);
    const kind = (r: Run) => r.events.find((e) => e.event === "result").kindBase64;
    expect(kind(a)).toBeTruthy();
    expect(kind(a)).not.toBe(kind(b));
  });
});

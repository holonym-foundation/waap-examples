// Repair round 01: assembled-command evidence. Each step runs the real CLI `main()` (argv
// parsing, exit-code mapping, journal/lock on disk) in its own OS process against the shared
// world file and fake waap-cli. Only the chain reads and waap-cli binary are substituted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HERE, readLog, tmpDir } from "./helpers.js";
import { Journal } from "../src/journal.js";
// @ts-expect-error untyped fixture module
import { newWorld, readWorld, writeWorld } from "./fixtures/world.mjs";

const ROOT = path.join(HERE, "..");
const RUN = path.join(HERE, "fixtures", "run-command.ts");

function world(overrides: Record<string, unknown> = {}) {
  const dir = tmpDir("proc-");
  const file = path.join(dir, "world.json");
  writeWorld(file, newWorld(overrides));
  const stateDir = path.join(dir, "state");
  const sends = () => readLog(path.join(dir, "waap-calls.jsonl")).filter((c) => c.args[0] === "send-tx");
  return { dir, file, stateDir, sends, read: () => readWorld(file), journal: () => new Journal(stateDir) };
}
type W = ReturnType<typeof world>;

interface Run {
  code: number | null;
  signal: string | null;
  events: any[];
  stderr: string;
}

function main(w: W, argv: string[], opts: { scenario?: string; effect?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const spec = { mode: "main", argv: [...argv, "--json"], stateDir: w.stateDir, world: w.file, ...opts };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code, signal) => {
      const events = stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));
      resolve({ code, signal, events, stderr });
    });
  });
}
const result = (r: Run) => r.events.find((e) => e.event === "result");
const error = (r: Run) => r.events.find((e) => e.event === "error");

describe("process boundary: lifecycle through main()", () => {
  it("supply → status → withdraw: exit 0 only with reconciled position, credit and residual; status sends nothing", async () => {
    const w = world({ obligations: [] });
    const s = await main(w, ["supply", "--amount", "3", "--yes"]);
    expect(s.code).toBe(0);
    expect(result(s)).toMatchObject({ outcome: "reconciled", suppliedSui: "3", position: { borrowCount: 0 } });
    const obl = w.read().obligations[0];
    expect(result(s).position).toMatchObject({ obligationId: obl.obligationId, capId: obl.capId });

    const sendsBefore = w.sends().length;
    const st = await main(w, ["status", "--watch", "5", "--iterations", "1"]);
    expect(st.code).toBe(0);
    expect(st.events[0]).toMatchObject({ event: "status", unresolvedSubmissions: [] });
    expect(w.sends()).toHaveLength(sendsBefore);

    const wd = await main(w, ["withdraw", "--amount", "1", "--yes"]);
    expect(wd.code).toBe(0);
    expect(result(wd)).toMatchObject({ outcome: "reconciled", walletCreditSui: "0.999999999", residual: { obligationId: obl.obligationId } });
    expect(Number(result(wd).residual.suppliedSui)).toBeCloseTo(2, 6);
  });
});

describe("process boundary: concurrency", () => {
  it("two concurrent `supply --yes` processes: one reconciles, the other exits 9 without sending", async () => {
    const w = world();
    const env = { FAKE_BARRIER_DIR: path.join(w.dir, "barrier"), FAKE_BARRIER_N: "2" };
    const [a, b] = await Promise.all([main(w, ["supply", "--amount", "1", "--yes"], { env }), main(w, ["withdraw", "--amount", "1", "--yes"], { env })]);
    expect([a.code, b.code].sort()).toEqual([0, 9]);
    expect(w.sends()).toHaveLength(1);
    expect(fs.existsSync(path.join(w.stateDir, "mutation.lock"))).toBe(false);
  });

  it("--allow-pending does not bypass the lock", async () => {
    const w = world();
    fs.mkdirSync(w.stateDir, { recursive: true });
    // a live holder: this test process
    fs.writeFileSync(path.join(w.stateDir, "mutation.lock"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t", startedAt: "x", command: "test" }));
    const r = await main(w, ["supply", "--amount", "1", "--yes", "--allow-pending"]);
    expect(r.code).toBe(9);
    expect(w.sends()).toHaveLength(0);
    const u = await main(w, ["journal", "unlock"]);
    expect(u.code).toBe(9); // holder is alive: refused
    expect(fs.existsSync(path.join(w.stateDir, "mutation.lock"))).toBe(true);
  });
});

describe("process boundary: restart after interruption", () => {
  it("killed after send before recording: restart is blocked, digest recovery reconciles, then a new send works", async () => {
    const w = world();
    const k = await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "kill-parent-after-send" });
    expect(k.code === 0).toBe(false);
    expect(w.sends()).toHaveLength(1);
    const [rec] = w.journal().open();
    expect(rec).toMatchObject({ state: "submitting", action: "supply" });
    expect(rec.digest).toBeUndefined();

    const again = await main(w, ["supply", "--amount", "1", "--yes"]);
    expect(again.code).toBe(9); // stale lock from the killed process
    expect(error(again).details.stale).toBe(true);

    const st = await main(w, ["status"]);
    expect(st.code).toBe(0);
    expect(result(st)).toMatchObject({ mutationInProgress: false, staleLock: { command: "supply 1" } });
    expect(result(st).unresolvedSubmissions).toHaveLength(1);

    expect((await main(w, ["journal", "unlock"])).code).toBe(0);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    const st2 = await main(w, ["status"]);
    expect(result(st2).unresolvedSubmissions).toHaveLength(1); // no digest: cannot reconcile alone

    const digest = Object.keys(w.read().txs)[0];
    const wrong = await main(w, ["journal", "reconcile", rec.id, "--digest", "FAKEdigestUnknown"]);
    expect(wrong.code).toBe(7);
    const rr = await main(w, ["journal", "reconcile", rec.id, "--digest", digest]);
    expect(rr.code).toBe(0);
    expect(result(rr)).toMatchObject({ outcome: "reconciled", digest });

    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(0);
    expect(w.sends()).toHaveLength(2);
  });

  it("delayed object visibility: exit 7, status keeps it open, then reconciles; no resend in between", async () => {
    const w = world();
    const r = await main(w, ["withdraw", "--amount", "1", "--yes"], { effect: "delayed:60" });
    expect(r.code).toBe(7);
    expect(error(r).details.digest).toMatch(/^FAKE/);
    expect((await main(w, ["withdraw", "--amount", "1", "--yes"])).code).toBe(8);
    expect(result(await main(w, ["status"])).unresolvedSubmissions).toHaveLength(1);
    const ww = w.read();
    ww.reads = 10_000;
    writeWorld(w.file, ww);
    const st = await main(w, ["status"]);
    expect(result(st).unresolvedSubmissions).toHaveLength(0);
    expect(w.journal().latest()[0]).toMatchObject({ state: "reconciled", report: { walletCreditSui: "0.999999999" } });
    expect(w.sends()).toHaveLength(1);
  });
});

describe("process boundary: status vs a running mutation (A4)", () => {
  it("status does not write the journal while another live process holds the lock; reconciles once it is released", async () => {
    const w = world();
    expect((await main(w, ["supply", "--amount", "1", "--yes"], { scenario: "pending" })).code).toBe(7); // effect applied, outcome unknown
    const jf = path.join(w.stateDir, "journal.jsonl");
    const lock = path.join(w.stateDir, "mutation.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t", startedAt: "x", command: "withdraw 1" }));
    const before = fs.readFileSync(jf, "utf8");
    const st = await main(w, ["status"]);
    expect(st.code).toBe(0);
    expect(result(st)).toMatchObject({ mutationInProgress: true });
    expect(result(st).unresolvedSubmissions).toHaveLength(1);
    expect(fs.readFileSync(jf, "utf8")).toBe(before);
    fs.rmSync(lock);
    const st2 = await main(w, ["status"]);
    expect(result(st2).unresolvedSubmissions).toHaveLength(0);
    expect(w.journal().latest()[0].state).toBe("reconciled");
  });

  it("killed while waiting for readback (after 'unreconciled' was persisted): restart → unlock → status reconciles, no resend", async () => {
    const w = world();
    const p = main(w, ["supply", "--amount", "1", "--yes"], { effect: "objects-delayed:100000" });
    // wait until the unreconciled record is durable, then kill that process
    const jf = path.join(w.stateDir, "journal.jsonl");
    for (let i = 0; i < 200 && !(fs.existsSync(jf) && fs.readFileSync(jf, "utf8").includes('"unreconciled"')); i++) await new Promise((r) => setTimeout(r, 25));
    // Fail with a named boundary (not a later missing result) if the poll timed out under load.
    expect(fs.readFileSync(jf, "utf8"), "unreconciled record not durable before the kill").toContain('"unreconciled"');
    const holder = JSON.parse(fs.readFileSync(path.join(w.stateDir, "mutation.lock"), "utf8"));
    process.kill(holder.pid, "SIGKILL");
    const killed = await p;
    expect(killed.code === 0).toBe(false);
    expect(w.journal().open()[0]).toMatchObject({ state: "unreconciled", digest: expect.stringMatching(/^FAKE/) });
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(9);
    expect((await main(w, ["journal", "unlock"])).code).toBe(0);
    const ww = w.read();
    ww.reads = ww.delayed.afterReads;
    writeWorld(w.file, ww);
    const stx = await main(w, ["status"]);
    expect(result(stx), `status gave no result: exit ${stx.code} signal ${stx.signal} events ${JSON.stringify(stx.events).slice(0, 800)} stderr ${stx.stderr.slice(0, 800)}`).toBeDefined();
    expect(result(stx).unresolvedSubmissions).toHaveLength(0);
    expect(w.sends()).toHaveLength(1);
  });
});

describe("process boundary: persistence failure", () => {
  it("journal unwritable after send: exit 7 naming the digest; restart blocked; digest recovery closes it", async () => {
    const w = world();
    const jf = path.join(w.stateDir, "journal.jsonl");
    const r = await main(w, ["supply", "--amount", "1", "--yes"], { env: { FAKE_WAAP_BREAK_JOURNAL: jf } });
    fs.chmodSync(jf, 0o600);
    expect(r.code).toBe(7);
    const digest = Object.keys(w.read().txs)[0];
    expect(error(r).message).toContain(digest);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    const st = await main(w, ["status"]);
    expect(result(st).unresolvedSubmissions).toHaveLength(1);
    const id = w.journal().open()[0].id;
    expect((await main(w, ["journal", "reconcile", id, "--digest", digest])).code).toBe(0);
    expect(w.sends()).toHaveLength(1);
  });

  it("journal unwritable before send: nothing is sent", async () => {
    const w = world();
    fs.mkdirSync(w.stateDir, { recursive: true });
    const jf = path.join(w.stateDir, "journal.jsonl");
    fs.writeFileSync(jf, "");
    fs.chmodSync(jf, 0o400);
    const r = await main(w, ["supply", "--amount", "1", "--yes"]);
    fs.chmodSync(jf, 0o600);
    expect(r.code).toBe(1);
    expect(w.sends()).toHaveLength(0);
  });
});

describe("process boundary: unreadable state and manual overrides", () => {
  it("truncated journal: every command exits 10; repair keeps a backup and a blocking record; ack is audited", async () => {
    const w = world();
    fs.mkdirSync(w.stateDir, { recursive: true });
    const jf = path.join(w.stateDir, "journal.jsonl");
    const raw = '{"id":"old","at":"2026-10-03T00:00:00Z","state":"submitting","address":"0x1"';
    fs.writeFileSync(jf, raw);
    for (const argv of [["supply", "--amount", "1", "--yes"], ["supply", "--amount", "1", "--yes", "--allow-pending"], ["withdraw", "--all", "--yes"], ["status"], ["journal"]]) {
      expect((await main(w, argv)).code).toBe(10);
    }
    const rep = await main(w, ["journal", "repair"]);
    expect(rep.code).toBe(0);
    expect(fs.readFileSync(result(rep).backup, "utf8")).toBe(raw);
    expect(result(rep).open).toHaveLength(1);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    const ack = await main(w, ["journal", "ack", result(rep).open[0]]);
    expect(result(ack)).toMatchObject({ reconciled: false, previousState: "pending" });
    expect((await main(w, ["journal", "ack", result(rep).open[0]])).code).toBe(2); // already closed
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(0);
    expect(w.sends()).toHaveLength(1);
  });

  it("position lookup failure, wrong network and debt-bearing position: no send, never success", async () => {
    const w1 = world({ fail: { obligations: "lookup failed" } });
    expect((await main(w1, ["supply", "--amount", "1", "--yes"])).code).toBe(1);
    expect((await main(w1, ["status"])).code).toBe(1);
    const w2 = world({ chainId: "notMainnet" });
    expect((await main(w2, ["supply", "--amount", "1", "--yes"])).code).toBe(3);
    expect((await main(w2, ["status"])).code).toBe(3);
    const debt = newWorld().obligations[0];
    const w3 = world({ obligations: [{ ...debt, borrowCount: 1 }] });
    expect((await main(w3, ["withdraw", "--all", "--yes"])).code).toBe(3);
    expect((await main(w3, ["supply", "--amount", "1", "--yes"])).code).toBe(3);
    for (const w of [w1, w2, w3]) expect(w.sends()).toHaveLength(0);
  });

  it("wrong signer on chain: exit 11 and the record stays open until acknowledged", async () => {
    const w = world();
    const r = await main(w, ["supply", "--amount", "1", "--yes"], { effect: "wrong-sender" });
    expect(r.code).toBe(11);
    expect((await main(w, ["supply", "--amount", "1", "--yes"])).code).toBe(8);
    expect(result(await main(w, ["status"])).unresolvedSubmissions[0].state).toBe("mismatch");
  });
});

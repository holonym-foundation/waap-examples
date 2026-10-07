// Regression tests: written against the earlier code first, then kept as a gate.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { statusCommand, supplyCommand, withdrawCommand, type Deps } from "../src/app.js";
import { Journal } from "../src/journal.js";
import { FAKE_WAAP, HERE, OWNER, readLog, tmpDir } from "./helpers.js";
import { worldChain } from "./world-chain.js";
// @ts-expect-error untyped fixture module
import { newWorld, readWorld, writeWorld, MAINNET_CHAIN_ID } from "./fixtures/world.mjs";

const ROOT = path.join(HERE, "..");
const RUN = path.join(HERE, "fixtures", "run-command.ts");

function world(overrides: Record<string, unknown> = {}) {
  const dir = tmpDir("repair-");
  const file = path.join(dir, "world.json");
  writeWorld(file, newWorld(overrides));
  const stateDir = path.join(dir, "state");
  const log = path.join(dir, "waap-calls.jsonl");
  const sends = () => readLog(log).filter((c) => c.args[0] === "send-tx");
  return { dir, file, stateDir, log, sends, read: () => readWorld(file), journal: () => new Journal(stateDir) };
}

type W = ReturnType<typeof world>;

function deps(w: W, scenario = "ok", extraEnv: Record<string, string> = {}): Deps & { progress: string[] } {
  const progress: string[] = [];
  return {
    chain: worldChain(w.file).deps,
    waap: {
      command: [process.execPath, FAKE_WAAP],
      env: { ...process.env, FAKE_WAAP_SCENARIO: scenario, FAKE_WAAP_LOG: w.log, FAKE_WAAP_ADDRESS: OWNER, FAKE_WORLD: w.file, ...extraEnv },
      childStdin: "ignore",
    },
    journal: new Journal(w.stateDir),
    reporter: { progress: (m: string) => progress.push(m), event: () => {} },
    reconcile: { attempts: 3, delayMs: 10 },
    progress,
  } as any;
}

function runProcess(spec: Record<string, unknown>): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUN, JSON.stringify(spec)], { cwd: ROOT, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const open = (w: W) => w.journal().open();

describe("F1 completion requires chain reconciliation, not a WaaP 'confirmed'", () => {
  it("supply: WaaP confirmed but nothing on chain → not success, record stays open", async () => {
    const w = world();
    await expect(supplyCommand(deps(w, "ok", { FAKE_WAAP_EFFECT: "none" }), { amount: "2", yes: true })).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    expect(open(w)).toHaveLength(1);
    expect(open(w)[0].digest).toMatch(/^FAKE/);
  });

  it("supply into the existing obligation: success reports the reconciled position and cap", async () => {
    const w = world();
    const r: any = await supplyCommand(deps(w), { amount: "2", yes: true });
    expect(r.outcome).toBe("reconciled");
    expect(r.position).toMatchObject({ obligationId: "0x" + "0a".repeat(32), capId: "0x" + "c1".repeat(32), borrowCount: 0 });
    expect(BigInt(r.position.suiCtokensAdded)).toBeGreaterThan(0n);
    expect(open(w)).toHaveLength(0);
  });

  it("supply creating a new obligation: success names the new obligation and its owner cap", async () => {
    const w = world({ obligations: [] });
    const r: any = await supplyCommand(deps(w), { amount: "2", yes: true });
    expect(r.outcome).toBe("reconciled");
    expect(r.position.obligationId).toBe(w.read().obligations[0].obligationId);
    expect(r.position.capId).toBe(w.read().obligations[0].capId);
  });

  it("withdraw: success reports wallet credit and residual position", async () => {
    const w = world();
    const r: any = await withdrawCommand(deps(w), { amount: "1", yes: true });
    expect(r.outcome).toBe("reconciled");
    expect(r.walletCreditSui).toBe("0.999999999");
    expect(r.residual).toMatchObject({ obligationId: "0x" + "0a".repeat(32), borrowCount: 0 });
    expect(Number(r.residual.suppliedSui)).toBeCloseTo(9.5, 6);
  });

  it("withdraw --all limited by liquidity reports the residual left supplied", async () => {
    const w = world();
    const s = w.read();
    s.market.availableMist = (3n * 10n ** 9n + 100n).toString();
    writeWorld(w.file, s);
    const r: any = await withdrawCommand(deps(w), { all: true, yes: true });
    expect(r.outcome).toBe("reconciled");
    expect(Number(r.walletCreditSui)).toBeCloseTo(3, 6);
    expect(Number(r.residual.suppliedSui)).toBeCloseTo(7.5, 6);
  });

  it("withdraw: position reduced but the owner's wallet not credited → RECONCILE_FAILED, not success", async () => {
    const w = world();
    await expect(withdrawCommand(deps(w, "ok", { FAKE_WAAP_EFFECT: "credit-elsewhere" }), { amount: "1", yes: true })).rejects.toMatchObject({
      code: "RECONCILE_FAILED",
      message: expect.stringMatching(/credited 0 SUI/),
    });
    expect(open(w)).toHaveLength(1);
  });

  it("delayed object visibility → PENDING_UNKNOWN, then status reconciles and unblocks", async () => {
    const w = world();
    const d = deps(w, "ok", { FAKE_WAAP_EFFECT: "delayed:40" });
    await expect(supplyCommand(d, { amount: "2", yes: true })).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    expect(open(w)).toHaveLength(1);
    await expect(supplyCommand(d, { amount: "1", yes: true })).rejects.toMatchObject({ code: "BLOCKED_BY_PENDING" });
    const s1 = await statusCommand(d, {}); // effect still hidden
    expect(s1.unresolvedSubmissions).toHaveLength(1);
    const ww = w.read();
    ww.reads = 1000;
    writeWorld(w.file, ww);
    const s2 = await statusCommand(d, {});
    expect(s2.unresolvedSubmissions).toHaveLength(0);
    expect(w.journal().latest()[0].state).toBe("reconciled");
    expect(w.sends()).toHaveLength(1);
  });

  it("transaction visible but objects lagging → PENDING_UNKNOWN (not a mismatch), later reconciled by status", async () => {
    const w = world();
    const d = deps(w, "ok", { FAKE_WAAP_EFFECT: "objects-delayed:40" });
    await expect(supplyCommand(d, { amount: "2", yes: true })).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    expect(w.journal().latest()[0].state).toBe("unreconciled");
    const ww = w.read();
    ww.reads = 1000;
    writeWorld(w.file, ww);
    expect((await statusCommand(d, {})).unresolvedSubmissions).toHaveLength(0);
    expect(w.journal().latest()[0].state).toBe("reconciled");
  });

  it("A3 status does not close an unknown outcome on transaction status alone", async () => {
    const w = world();
    const d = deps(w, "pending", { FAKE_WAAP_EFFECT: "none" });
    await expect(supplyCommand(d, { amount: "2", yes: true })).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    // chain says the digest succeeded, but the position never changed
    const ww = w.read();
    const digest = w.journal().latest()[0].digest!;
    ww.txs[digest] = { status: "success", sender: OWNER, gasOwner: OWNER, gasMist: "2000000", suiChange: { [OWNER]: "-2002000000" } };
    writeWorld(w.file, ww);
    const s = await statusCommand(d, {});
    expect(s.unresolvedSubmissions).toHaveLength(1);
  });
});

describe("F2 a different signer is never success", () => {
  it("WaaP reports another sender → RECONCILE_FAILED, record stays open", async () => {
    const w = world();
    const d = deps(w, "other-sender", { FAKE_WAAP_EFFECT: "wrong-sender" });
    await expect(supplyCommand(d, { amount: "1", yes: true })).rejects.toMatchObject({ code: "RECONCILE_FAILED" });
    expect(open(w)).toHaveLength(1);
  });
  it("WaaP reports the owner but the chain shows another sender → RECONCILE_FAILED", async () => {
    const w = world();
    await expect(supplyCommand(deps(w, "ok", { FAKE_WAAP_EFFECT: "wrong-sender" }), { amount: "1", yes: true })).rejects.toMatchObject({
      code: "RECONCILE_FAILED",
    });
    expect(open(w)).toHaveLength(1);
  });
});

describe("F3 an unreadable journal is unknown state, never empty", () => {
  for (const [label, content] of [
    ["truncated pending record", '{"id":"old","at":"2026-10-03T00:00:00Z","state":"submitting","address":"0x1"'],
    ["record with an invalid state", '{"id":"x","at":"2026-10-03T00:00:00Z","state":"bogus"}\n'],
  ] as const) {
    it(`${label}: supply/withdraw/status refuse, nothing sent; --allow-pending does not bypass`, async () => {
      const w = world();
      fs.mkdirSync(w.stateDir, { recursive: true });
      fs.writeFileSync(path.join(w.stateDir, "journal.jsonl"), content);
      const d = deps(w);
      await expect(supplyCommand(d, { amount: "1", yes: true })).rejects.toMatchObject({ code: "STATE_UNREADABLE" });
      await expect(supplyCommand(d, { amount: "1", yes: true, allowPending: true })).rejects.toMatchObject({ code: "STATE_UNREADABLE" });
      await expect(withdrawCommand(d, { amount: "1", yes: true })).rejects.toMatchObject({ code: "STATE_UNREADABLE" });
      await expect(statusCommand(d, {})).rejects.toMatchObject({ code: "STATE_UNREADABLE" });
      expect(w.sends()).toHaveLength(0);
    });
  }
});

describe("F4 one mutation per state directory across OS processes", () => {
  for (const [a, b] of [
    [{ command: "supply", opts: { amount: "1", yes: true } }, { command: "supply", opts: { amount: "1", yes: true } }],
    [{ command: "supply", opts: { amount: "1", yes: true } }, { command: "withdraw", opts: { amount: "1", yes: true } }],
  ]) {
    it(`${a.command} vs ${b.command}: at most one send, loser fails without sending`, async () => {
      const w = world();
      const barrier = path.join(w.dir, "barrier");
      const env = { FAKE_BARRIER_DIR: barrier, FAKE_BARRIER_N: "2" };
      const [ra, rb] = await Promise.all([
        runProcess({ mode: "command", ...a, stateDir: w.stateDir, world: w.file, env }),
        runProcess({ mode: "command", ...b, stateDir: w.stateDir, world: w.file, env }),
      ]);
      const outs = [ra, rb].map((r) => JSON.parse(r.stdout.trim().split("\n").pop()!));
      expect(w.sends()).toHaveLength(1);
      expect(outs.filter((o) => o.ok)).toHaveLength(1);
      expect(outs.find((o) => !o.ok).code).toBe("LOCKED");
    });
  }
});

describe("A1 persistence failure after send keeps the digest and blocks", () => {
  it("journal becomes unwritable during send → non-success with digest; earlier record still blocks", async () => {
    const w = world();
    const journalFile = path.join(w.stateDir, "journal.jsonl");
    const d = deps(w, "ok", { FAKE_WAAP_BREAK_JOURNAL: journalFile });
    const err: any = await supplyCommand(d, { amount: "1", yes: true }).catch((e) => e);
    fs.chmodSync(journalFile, 0o600);
    expect(err.code).toBe("PENDING_UNKNOWN");
    expect(err.message).toMatch(/FAKEdigest/);
    expect(open(w)).toHaveLength(1);
    await expect(supplyCommand(deps(w), { amount: "1", yes: true })).rejects.toMatchObject({ code: "BLOCKED_BY_PENDING" });
    expect(w.sends()).toHaveLength(1);
  });
});

describe("A2 the read node must be Sui mainnet", () => {
  it("another chain identifier refuses before planning", async () => {
    const w = world({ chainId: "notMainnet111" });
    await expect(supplyCommand(deps(w), { amount: "1" })).rejects.toMatchObject({ code: "PREFLIGHT_REFUSED" });
    expect(MAINNET_CHAIN_ID).toMatch(/^4btiui/);
  });
});

import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { statusCommand, supplyCommand, withdrawCommand, type Deps } from "../src/app.js";
import { Journal } from "../src/journal.js";
import { inspectKind } from "../src/inspect.js";
import { fromBase64 } from "@mysten/sui/utils";
import { FAKE_WAAP, MIST, OWNER, fakeChain, market, obligation, readLog, tmpDir, wallet } from "./helpers.js";
import { worldChain } from "./world-chain.js";
// @ts-expect-error untyped fixture module
import { newWorld, readWorld, writeWorld } from "./fixtures/world.mjs";

function setup(scenario = "ok", chainState: Parameters<typeof fakeChain>[0] = {}) {
  const dir = tmpDir("app-");
  const log = path.join(dir, "waap-calls.jsonl");
  const chain = fakeChain(chainState);
  const progress: string[] = [];
  const events: { name: string; data: any }[] = [];
  const deps: Deps = {
    chain: chain.deps,
    waap: {
      command: [process.execPath, FAKE_WAAP],
      env: { ...process.env, FAKE_WAAP_SCENARIO: scenario, FAKE_WAAP_LOG: log, FAKE_WAAP_ADDRESS: OWNER },
      childStdin: "ignore",
    },
    journal: new Journal(path.join(dir, "state")),
    reporter: { progress: (m) => progress.push(m), event: (name, data) => events.push({ name, data }) },
  };
  const sends = () => readLog(log).filter((c) => c.args[0] === "send-tx");
  return { deps, chain, progress, events, sends, journal: deps.journal };
}

/** Repair round 01: submissions need a chain whose state the send actually changes. */
function setupWorld(scenario = "ok", worldOverrides: Record<string, unknown> = {}, effect?: string) {
  const dir = tmpDir("appw-");
  const file = path.join(dir, "world.json");
  writeWorld(file, newWorld(worldOverrides));
  const log = path.join(dir, "waap-calls.jsonl");
  const progress: string[] = [];
  const events: { name: string; data: any }[] = [];
  const deps: Deps = {
    chain: worldChain(file).deps,
    waap: {
      command: [process.execPath, FAKE_WAAP],
      env: { ...process.env, FAKE_WAAP_SCENARIO: scenario, FAKE_WAAP_LOG: log, FAKE_WAAP_ADDRESS: OWNER, FAKE_WORLD: file, ...(effect ? { FAKE_WAAP_EFFECT: effect } : {}) },
      childStdin: "ignore",
    },
    journal: new Journal(path.join(dir, "state")),
    reporter: { progress: (m) => progress.push(m), event: (name, data) => events.push({ name, data }) },
    reconcile: { attempts: 2, delayMs: 5 },
  };
  const sends = () => readLog(log).filter((c) => c.args[0] === "send-tx");
  return { deps, progress, events, sends, journal: deps.journal, world: () => readWorld(file), file };
}

describe("supply", () => {
  it("dry run by default: plan + simulation, nothing sent, no journal entry", async () => {
    const t = setup();
    const r = await supplyCommand(t.deps, { amount: "2" });
    expect(r).toMatchObject({ dryRun: true, action: "supply", amountSui: "2", obligation: expect.stringMatching(/^0x/), simulated: true });
    expect(t.sends()).toHaveLength(0);
    expect(t.journal.all()).toHaveLength(0);
    expect(t.chain.state.simulated[0].sender).toBe(OWNER);
  });

  it("--yes submits the exact inspected kind bytes and records the reconciled outcome", async () => {
    const t = setupWorld();
    const r = await supplyCommand(t.deps, { amount: "2", yes: true });
    expect(r).toMatchObject({ submitted: true, outcome: "reconciled", digest: expect.any(String) });
    const [send] = t.sends();
    const sent = send.args[send.args.indexOf("--tx") + 1];
    expect(sent).toBe(r.kindBase64);
    // what was sent decodes to a transaction that passes inspection for a 2 SUI supply, with its
    // submission nonce (follow-up 3 migration: without the nonce, inspection now refuses it)
    const plan2 = { action: "supply" as const, owner: OWNER, amountMist: 2n * MIST, obligation: { kind: "existing" as const, obligationId: obligation().obligationId, capId: obligation().capId, obligation: obligation() }, expectedCtokens: 0n, warnings: [] };
    const data = Transaction.fromKind(fromBase64(sent)).getData();
    const mv = data.commands.find((c: any) => c.$kind === "MakeMoveVec") as any;
    const nonceInput = data.inputs[mv.MakeMoveVec.elements[0].Input] as any;
    const nonce = Uint8Array.from(bcs.vector(bcs.u8()).parse(fromBase64(nonceInput.Pure.bytes)));
    expect(nonce).toHaveLength(16);
    expect(() => inspectKind(fromBase64(sent), plan2, market(), nonce)).not.toThrow();
    expect(() => inspectKind(fromBase64(sent), plan2, market())).toThrow(/nonce/);
    expect(t.journal.latest()).toMatchObject([{ state: "reconciled", action: "supply", address: OWNER }]);
  });

  it("E1 invalid amount fails before any WaaP or chain call", async () => {
    const t = setup();
    await expect(supplyCommand(t.deps, { amount: "1e9" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(supplyCommand(t.deps, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(t.chain.state.reads).toHaveLength(0);
  });

  it("A2 simulation failure → not submitted", async () => {
    const t = setup("ok", { simulation: { ok: false, reason: "SuiLend outflow rate limit reached", abort: { module: "rate_limiter", code: "2" } } });
    await expect(supplyCommand(t.deps, { amount: "2", yes: true })).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
    expect(t.sends()).toHaveLength(0);
    expect(t.journal.all()).toHaveLength(0);
  });

  it("--skip-simulate skips only the simulation", async () => {
    const t = setup();
    const dry = await supplyCommand(t.deps, { amount: "2", skipSimulate: true });
    expect(dry).toMatchObject({ simulated: false });
    expect(t.chain.state.simulated).toHaveLength(0);
    const w = setupWorld();
    expect(await supplyCommand(w.deps, { amount: "2", yes: true, skipSimulate: true })).toMatchObject({ simulated: false, outcome: "reconciled" });
  });

  it("E25 --address must match the WaaP account", async () => {
    const t = setup();
    await expect(supplyCommand(t.deps, { amount: "1", address: "0x" + "b2".repeat(32) })).rejects.toMatchObject({ code: "PREFLIGHT_REFUSED" });
    expect(t.chain.state.reads).toHaveLength(0);
  });

  it("E3 refusal comes from chain state, nothing sent", async () => {
    const t = setup("ok", { wallet: wallet(MIST) });
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "PREFLIGHT_REFUSED" });
    expect(t.sends()).toHaveLength(0);
  });

  it("E20 2FA link is surfaced as an event", async () => {
    const t = setupWorld("2fa-then-ok");
    await supplyCommand(t.deps, { amount: "1", yes: true });
    expect(t.events).toEqual([{ name: "awaiting_2fa", data: expect.objectContaining({ confirm_url: "https://approve.example/p1" }) }]);
  });

  it.each([
    ["onchain-failed", "ONCHAIN_FAILED", "failed"],
    ["policy-rejected", "WAAP_REJECTED", "rejected"],
    ["2fa-timeout", "WAAP_REJECTED", "rejected"],
    ["pending", "PENDING_UNKNOWN", "pending"],
    ["network-error", "PENDING_UNKNOWN", "pending"],
    ["crash", "PENDING_UNKNOWN", "pending"],
  ])("outcome %s → %s, journal %s", async (scenario, code, state) => {
    const t = setupWorld(scenario);
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code });
    expect(t.journal.latest()[0].state).toBe(state);
  });

  it("phone 2FA without a terminal is warned about and ends as not executed", async () => {
    const t = setup("phone-2fa");
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "WAAP_REJECTED" });
    expect(t.events[0].data).toMatchObject({ method: "phone_authz", code_entry: expect.stringMatching(/impossible/) });
    expect(t.progress.join("\n")).toMatch(/phone 2FA code/);
    expect(t.progress.join("\n")).toMatch(/\[waap-cli\] Enter the 6-digit code/);
  });

  it("E24 a different sender reported by WaaP is not a success (repair 01: was only a warning)", async () => {
    const t = setupWorld("other-sender", {}, "wrong-sender");
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "RECONCILE_FAILED", message: expect.stringMatching(/WaaP reports sender/) });
    expect(t.journal.latest()[0].state).toBe("mismatch");
  });

  it("E26/A5 an unknown outcome blocks the next submission before any chain read", async () => {
    const t = setupWorld("pending");
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    const readsBefore = t.world().reads;
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "BLOCKED_BY_PENDING" });
    await expect(withdrawCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "BLOCKED_BY_PENDING" });
    // even a dry run is blocked: its plan would be computed on possibly stale state
    await expect(supplyCommand(t.deps, { amount: "1" })).rejects.toMatchObject({ code: "BLOCKED_BY_PENDING" });
    expect(t.world().reads).toBe(readsBefore);
    expect(t.sends()).toHaveLength(1);
  });

  it("status reconciles a pending entry from chain, which unblocks submissions", async () => {
    const t = setupWorld("pending");
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    const s = await statusCommand(t.deps, {});
    expect(s.unresolvedSubmissions).toHaveLength(0);
    expect(t.journal.latest()[0].state).toBe("reconciled");
    await expect(supplyCommand(t.deps, { amount: "1" })).resolves.toMatchObject({ dryRun: true });
  });

  it("a pending entry the chain does not know yet stays open", async () => {
    const t = setupWorld("pending", {}, "none");
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toThrow();
    const s = await statusCommand(t.deps, {});
    expect(s.unresolvedSubmissions).toHaveLength(1);
  });

  // Session 2 (S2): migrated. --allow-pending no longer overrides a record whose outcome is unknown.
  it("--allow-pending does not override a pending (unknown-outcome) record", async () => {
    const t = setup("pending");
    await expect(supplyCommand(t.deps, { amount: "1", yes: true })).rejects.toThrow();
    await expect(supplyCommand(t.deps, { amount: "1", allowPending: true })).rejects.toMatchObject({ code: "BLOCKED_BY_PENDING" });
  });
});

describe("withdraw", () => {
  it("amount: dry run then submit", async () => {
    const t = setup();
    expect(await withdrawCommand(t.deps, { amount: "1" })).toMatchObject({ dryRun: true, estimatedSui: "0.999999999" });
    const w = setupWorld();
    expect(await withdrawCommand(w.deps, { amount: "1", yes: true })).toMatchObject({ outcome: "reconciled", walletCreditSui: "0.999999999" });
    expect(w.journal.latest()[0]).toMatchObject({ action: "withdraw", summary: "withdraw 1 SUI", state: "reconciled" });
  });
  it("--all", async () => {
    const t = setup();
    expect(await withdrawCommand(t.deps, { all: true })).toMatchObject({ all: true, ctokens: "max", estimatedSui: "10.5" });
  });
  it("--amount with --all is invalid", async () => {
    const t = setup();
    await expect(withdrawCommand(t.deps, { all: true, amount: "1" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("E9 obligation with borrows is refused", async () => {
    const t = setup("ok", { obligations: [obligation({ borrowCount: 1 })] });
    await expect(withdrawCommand(t.deps, { all: true, yes: true })).rejects.toMatchObject({ code: "PREFLIGHT_REFUSED" });
    expect(t.sends()).toHaveLength(0);
  });
});

describe("status", () => {
  it("reports wallet, supplied SUI and flags borrowing obligations", async () => {
    const t = setup("ok", { obligations: [obligation(), obligation({ obligationId: "0x" + "0b".repeat(32), borrowCount: 1, suiCtokens: 0n })] });
    const s = await statusCommand(t.deps, {});
    expect(s.address).toBe(OWNER);
    expect(s.obligations[0]).toMatchObject({ suppliedSui: "10.5", managedByRecipe: true });
    expect(s.obligations[1]).toMatchObject({ borrowCount: 1, managedByRecipe: false });
    expect(s.reserve).toMatchObject({ supplyAprPercent: "2.5000", depositLimitHeadroomSui: "7900000" });
  });
  it("--address reads any address without WaaP", async () => {
    const t = setup("no-session");
    const other = "0x" + "77".repeat(32);
    expect((await statusCommand(t.deps, { address: other })).address).toBe(other);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWaap, sendTxArgs, waapSendKind, waapSuiAddress, waapVersion, type WaapOptions } from "../src/waap.js";
import { FAKE_WAAP, OWNER, readLog, tmpDir } from "./helpers.js";

function opts(scenario: string, extra: Record<string, string> = {}): WaapOptions & { log: string } {
  const log = path.join(tmpDir("waap-"), "calls.jsonl");
  return {
    log,
    command: [process.execPath, FAKE_WAAP],
    env: { ...process.env, FAKE_WAAP_SCENARIO: scenario, FAKE_WAAP_LOG: log, FAKE_WAAP_ADDRESS: OWNER, ...extra },
  };
}
const KIND = Buffer.from("kind-bytes").toString("base64");

describe("waap-cli runner (fake binary)", () => {
  it("passes exact argv with the kind bytes as a literal --tx value; stdin left for 2FA", async () => {
    const o = opts("ok");
    const out = await waapSendKind(KIND, o);
    expect(out).toEqual({ kind: "confirmed", digest: expect.any(String), from: OWNER });
    const [call] = readLog(o.log);
    expect(call.args).toEqual(["send-tx", "--chain", "sui:mainnet", "--tx", KIND, "--tx-format", "base64", "--json", "--wait"]);
    expect(call.stdin).toBe("");
    expect(sendTxArgs(KIND)).not.toContain("--gastank");
  });

  it("rejects non-canonical base64 before starting waap-cli", async () => {
    const o = opts("ok");
    await expect(waapSendKind("not base64!", o)).rejects.toThrow(/canonical base64/);
    expect(readLog(o.log)).toHaveLength(0);
  });

  it("phone 2FA: a code typed on the child's stdin completes it; no terminal → TWO_FA_TIMEOUT", async () => {
    const text: string[] = [];
    const typed = await waapSendKind(KIND, { ...opts("phone-2fa"), childStdin: { text: "123456\n" }, onText: (l) => text.push(l) });
    expect(typed.kind).toBe("confirmed");
    expect(text.join()).toMatch(/Enter the 6-digit code/); // interactive prompt forwarded, not dropped
    const none = await waapSendKind(KIND, { ...opts("phone-2fa"), childStdin: "ignore" });
    expect(none).toMatchObject({ kind: "rejected", waapCode: "TWO_FA_TIMEOUT" });
  });

  it("E20 streams awaiting_2fa (with confirm_url) before the child exits", async () => {
    const o = opts("2fa-then-ok", { FAKE_WAAP_DELAY_MS: "600" });
    const seen: { event: string; at: number }[] = [];
    const out = await waapSendKind(KIND, { ...o, onEvent: (e) => seen.push({ event: e.event, at: Date.now() }) });
    const done = Date.now();
    expect(out.kind).toBe("confirmed");
    const twofa = seen.find((s) => s.event === "awaiting_2fa")!;
    expect(twofa).toBeDefined();
    expect(done - twofa.at).toBeGreaterThanOrEqual(400); // surfaced while the child was still waiting
  });

  it.each([
    ["onchain-failed", { kind: "failed" }],
    ["pending", { kind: "unknown" }],
    ["confirmation-error", { kind: "unknown" }],
    ["policy-rejected", { kind: "rejected", waapCode: "POLICY_REJECTED" }],
    ["2fa-timeout", { kind: "rejected", waapCode: "TWO_FA_TIMEOUT" }],
    ["insufficient-funds", { kind: "rejected", waapCode: "INSUFFICIENT_FUNDS" }],
    ["network-error", { kind: "unknown" }],
    ["garbage", { kind: "unknown" }],
    ["crash", { kind: "unknown" }],
  ])("E19/E21/E22/E23 scenario %s → %j", async (scenario, expected) => {
    expect(await waapSendKind(KIND, opts(scenario))).toMatchObject(expected);
  });

  it("pending keeps the digest so status can resolve it", async () => {
    const out = await waapSendKind(KIND, opts("pending"));
    expect(out).toMatchObject({ kind: "unknown", digest: expect.any(String) });
  });

  it("whoami → Sui address; NO_SESSION → WAAP_REJECTED with login hint", async () => {
    expect(await waapSuiAddress(opts("ok"))).toBe(OWNER);
    await expect(waapSuiAddress(opts("no-session"))).rejects.toMatchObject({ code: "WAAP_REJECTED", message: expect.stringMatching(/login/) });
  });

  it("version", async () => expect(await waapVersion(opts("ok"))).toBe("2.2.1"));

  it("E18 missing binary is a clear error", async () => {
    await expect(runWaap(["--version"], undefined, { command: ["/nonexistent/waap-cli"] })).rejects.toThrow(/Could not start waap-cli/);
  });
});

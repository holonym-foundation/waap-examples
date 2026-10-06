import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { FAKE_WAAP, OWNER, tmpDir } from "./helpers.js";

function env(scenario = "ok") {
  const dir = tmpDir("cli-");
  return {
    dir,
    env: {
      ...process.env,
      WAAP_CLI_BIN: FAKE_WAAP,
      FAKE_WAAP_SCENARIO: scenario,
      FAKE_WAAP_ADDRESS: OWNER,
      SUILEND_WAAP_STATE_DIR: path.join(dir, "state"),
    } as NodeJS.ProcessEnv,
  };
}

let stdout: string[] = [];
let stderr: string[] = [];
afterEach(() => vi.restoreAllMocks());
function capture() {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void stdout.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.join(" ")));
}
const events = () => stdout.map((l) => JSON.parse(l));

describe("cli", () => {
  it("help exits 0, no command exits 2", async () => {
    capture();
    expect(await main(["--help"], env().env)).toBe(0);
    expect(await main([], env().env)).toBe(2);
  });

  it("unknown flags and commands are usage errors (2)", async () => {
    capture();
    expect(await main(["supply", "--amonut", "1"], env().env)).toBe(2);
    expect(await main(["lend"], env().env)).toBe(2);
  });

  it("E2 supply has no --all / implicit max", async () => {
    capture();
    expect(await main(["supply", "--all", "--json"], env().env)).toBe(2);
    expect(events()[0]).toMatchObject({ event: "error", code: "INVALID_INPUT" });
    expect(await main(["supply", "--json"], env().env)).toBe(2);
  });

  it("address via fake waap-cli, JSON event shape", async () => {
    capture();
    expect(await main(["address", "--json"], env().env)).toBe(0);
    expect(events()).toEqual([{ event: "result", address: OWNER, chain: "sui:mainnet" }]);
  });

  it("NO_SESSION maps to exit 5", async () => {
    capture();
    expect(await main(["address", "--json"], env("no-session").env)).toBe(5);
    expect(events()[0]).toMatchObject({ event: "error", code: "WAAP_REJECTED" });
  });

  it("doctor reports versions without network", async () => {
    capture();
    expect(await main(["doctor", "--json"], env().env)).toBe(0);
    expect(events()[0]).toMatchObject({ waapCliVersion: "2.2.1", waapCliVersionMatches: true, chain: "sui:mainnet" });
    capture();
    expect(await main(["doctor", "--json"], { ...env().env, FAKE_WAAP_VERSION: "3.0.0" })).toBe(0);
    expect(events()[0]).toMatchObject({ waapCliVersionMatches: false });
  });

  it("journal list/ack; read-only commands do not create the state dir", async () => {
    const e = env();
    capture();
    expect(await main(["journal", "--json"], e.env)).toBe(0);
    expect(events()[0].records).toEqual([]);
    expect(fs.existsSync(path.join(e.dir, "state"))).toBe(false);
    expect(await main(["journal", "ack", "nope"], e.env)).toBe(2);
  });

  it("--watch validates its interval", async () => {
    capture();
    expect(await main(["status", "--watch", "1", "--address", OWNER], env().env)).toBe(2);
  });

  it("status against the live adapter cannot reach the network in tests (trap) → exit 1, no hang", async () => {
    capture();
    const code = await main(["status", "--address", OWNER, "--json"], env().env);
    expect(code).toBe(1);
    expect(events()[0]).toMatchObject({ event: "error", code: "UNEXPECTED" });
    expect(events()[0].message).toMatch(/NETWORK_BLOCKED/);
  });
});

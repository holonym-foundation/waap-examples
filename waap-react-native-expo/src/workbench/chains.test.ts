import { describe, expect, it } from "vitest";

import { evmExplorerUrl } from "../../explorer";
import { EVM_CHAINS, evmChain } from "./chains";

describe("EVM chains", () => {
  // The web demo's list, minus local Hardhat: a phone cannot reach it.
  it("offers the web demo networks, Sepolia first", () => {
    expect(EVM_CHAINS.map((chain) => chain.id)).toEqual([
      "0xaa36a7",
      "0x14a34",
      "0x61",
      "0x1",
    ]);
  });

  it("carries each chain id as the number typed data signs over", () => {
    expect(evmChain("0x14a34")?.chainId).toBe(84532);
    expect(evmChain("0x61")?.chainId).toBe(97);
  });

  // A real-funds network is for signing only, as on the web demo.
  it("sends only on testnets", () => {
    expect(
      EVM_CHAINS.filter((chain) => chain.canSend).map((c) => c.id),
    ).toEqual(["0xaa36a7", "0x14a34", "0x61"]);
  });

  it("links every sendable chain to an explorer", () => {
    for (const chain of EVM_CHAINS.filter((c) => c.canSend)) {
      expect(evmExplorerUrl(chain.id, "0xabc")).toMatch(/^https:\/\//);
    }
  });

  it("knows nothing about an unlisted chain", () => {
    expect(evmChain("0x2a")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { evmExplorerUrl } from "../../explorer";
import { EVM_CHAINS, evmChain } from "./chains";

describe("EVM chains", () => {
  // The web demo also lists BSC Testnet; the production wallet refuses it.
  it("offers the networks the production wallet accepts", () => {
    expect(EVM_CHAINS.map((chain) => chain.id)).toEqual([
      "0xaa36a7",
      "0x14a34",
      "0x1",
    ]);
  });

  it("carries each chain id as the number typed data signs over", () => {
    expect(evmChain("0x14a34")?.chainId).toBe(84532);
  });

  // A real-funds network is for signing only, as on the web demo.
  it("sends only on testnets", () => {
    expect(
      EVM_CHAINS.filter((chain) => chain.canSend).map((c) => c.id),
    ).toEqual(["0xaa36a7", "0x14a34"]);
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

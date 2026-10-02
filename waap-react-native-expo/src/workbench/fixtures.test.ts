import { hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  LONG_PERSONAL_MESSAGE,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_USDC,
  SHORT_PERSONAL_MESSAGE,
  nestedTypedData,
  selfTransfer,
  simpleTypedData,
  utf8Hex,
  verifyPersonalSign,
  verifyTypedDataSignature,
} from "./fixtures";

// A throwaway key: the point is that what the wallet signs verifies locally.
const signer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const stranger = "0x00000000000000000000000000000000000000aa";

describe("fixtures", () => {
  it("match the web demo values", () => {
    expect(SHORT_PERSONAL_MESSAGE).toBe("Confirm this WaaP demo message.");
    expect(LONG_PERSONAL_MESSAGE.split("\n")).toHaveLength(24);
    expect(SEPOLIA_CHAIN_ID).toBe(11155111);
    expect(SEPOLIA_USDC).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
  });

  it("hex-encodes personal messages the way the wallet decodes them", () => {
    expect(hexToString(utf8Hex(SHORT_PERSONAL_MESSAGE))).toBe(
      SHORT_PERSONAL_MESSAGE,
    );
  });

  // uint256 travels as a decimal string, exactly as on the web demo.
  it("carries typed-data nonces as strings, pinned to Sepolia", () => {
    const data = simpleTypedData();
    expect(data.domain.chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(data.message.nonce).toBe("1");
    expect(nestedTypedData(signer.address).message.from.wallet).toBe(
      signer.address,
    );
  });

  // The wallet refuses typed data whose domain names another chain.
  it("builds typed data for the chain it will be signed on", async () => {
    const baseSepolia = 84532;
    const wire = nestedTypedData(signer.address, baseSepolia);
    expect(simpleTypedData(baseSepolia).domain.chainId).toBe(baseSepolia);
    expect(wire.domain.chainId).toBe(baseSepolia);

    const signature = await signer.signTypedData({
      ...wire,
      message: { ...wire.message, nonce: 42n },
    } as never);
    await expect(
      verifyTypedDataSignature(signer.address, wire, signature),
    ).resolves.toBe(true);
  });

  it("sends nothing to the sender", () => {
    expect(selfTransfer("0xabc")).toEqual({
      from: "0xabc",
      to: "0xabc",
      value: "0x0",
    });
  });
});

describe("verification", () => {
  it("accepts a personal_sign signature from the signer only", async () => {
    const signature = await signer.signMessage({
      message: SHORT_PERSONAL_MESSAGE,
    });
    await expect(
      verifyPersonalSign(signer.address, SHORT_PERSONAL_MESSAGE, signature),
    ).resolves.toBe(true);
    await expect(
      verifyPersonalSign(stranger, SHORT_PERSONAL_MESSAGE, signature),
    ).resolves.toBe(false);
  });

  it("verifies the wire-shaped typed data the wallet signed", async () => {
    const wire = nestedTypedData(signer.address);
    const signature = await signer.signTypedData({
      ...wire,
      message: { ...wire.message, nonce: 42n },
    } as never);
    await expect(
      verifyTypedDataSignature(signer.address, wire, signature),
    ).resolves.toBe(true);
    await expect(
      verifyTypedDataSignature(stranger, wire, signature),
    ).resolves.toBe(false);
  });
});

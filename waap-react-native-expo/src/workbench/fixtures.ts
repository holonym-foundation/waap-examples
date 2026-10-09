import { stringToHex, verifyMessage, verifyTypedData, type Hex } from "viem";

// Values mirror the WaaP web SDK demo and the Flutter workbench so results
// compare across platforms.

export const SHORT_PERSONAL_MESSAGE = "Confirm this WaaP demo message.";

export const LONG_PERSONAL_MESSAGE = Array.from(
  { length: 24 },
  (_, index) =>
    `Line ${String(index + 1).padStart(2, "0")}: This deterministic WaaP message tests long-content scrolling, exact bytes, and signature verification without hiding any content.`,
).join("\n");

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const SOLANA_DEVNET = "solana:devnet";
export const SOLANA_MESSAGE = "Confirm this WaaP Solana demo message.";

export const utf8Hex = (text: string): Hex => stringToHex(text);

// The wallet refuses typed data whose domain names a chain other than the one
// it is on, so the domain follows the selected chain.
const domain = (chainId: number) => ({
  name: "WaaP SDK Demo",
  version: "1",
  chainId,
  verifyingContract: SEPOLIA_USDC as Hex,
});

export const simpleTypedData = (chainId = SEPOLIA_CHAIN_ID) => ({
  domain: domain(chainId),
  types: {
    WaaPMessage: [
      { name: "contents", type: "string" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "WaaPMessage",
  message: {
    contents: "Review and sign this simple WaaP EIP-712 message.",
    nonce: "1",
  },
});

export const nestedTypedData = (
  signer: string,
  chainId = SEPOLIA_CHAIN_ID,
) => ({
  domain: domain(chainId),
  types: {
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Attachment: [
      { name: "name", type: "string" },
      { name: "digest", type: "bytes32" },
    ],
    WaaPEnvelope: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "attachments", type: "Attachment[]" },
      { name: "memo", type: "string" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "WaaPEnvelope",
  message: {
    from: { name: "Connected signer", wallet: signer },
    to: { name: "Demo recipient", wallet: SEPOLIA_USDC },
    attachments: [
      {
        name: "review.json",
        digest:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
      {
        name: "receipt.json",
        digest:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
      },
    ],
    memo: "Nested structs and arrays exercise the complex typed-data review UI.",
    nonce: "42",
  },
});

export type WireTypedData =
  ReturnType<typeof simpleTypedData> | ReturnType<typeof nestedTypedData>;

export const selfTransfer = (from: string) => ({
  from,
  to: from,
  value: "0x0",
});

export const verifyPersonalSign = (
  address: string,
  message: string,
  signature: string,
) =>
  verifyMessage({
    address: address as Hex,
    message,
    signature: signature as Hex,
  });

/** The wire form carries uint256 as a string; hashing needs the integer. */
export const verifyTypedDataSignature = (
  address: string,
  typedData: WireTypedData,
  signature: string,
) =>
  verifyTypedData({
    ...typedData,
    message: { ...typedData.message, nonce: BigInt(typedData.message.nonce) },
    address: address as Hex,
    signature: signature as Hex,
  } as Parameters<typeof verifyTypedData>[0]);

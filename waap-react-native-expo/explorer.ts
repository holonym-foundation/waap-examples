import { getBase58Decoder } from "@solana/kit";

/**
 * Block-explorer links for the chains this demo can reach.
 *
 * A transaction id on its own is not verifiable by eye — being able to open it
 * is what turns "the SDK returned something" into "the transaction landed".
 */
const EVM_EXPLORERS: Record<string, string> = {
  "0x1": "https://etherscan.io/tx/",
  "0xaa36a7": "https://sepolia.etherscan.io/tx/",
  "0x2105": "https://basescan.org/tx/",
  "0x14a34": "https://sepolia.basescan.org/tx/",
  "0x61": "https://testnet.bscscan.com/tx/",
  "0xa4b1": "https://arbiscan.io/tx/",
  "0xa": "https://optimistic.etherscan.io/tx/",
  "0x89": "https://polygonscan.com/tx/",
};

export function evmExplorerUrl(
  chainId: string | null,
  txHash: string,
): string | undefined {
  const base = chainId ? EVM_EXPLORERS[chainId] : undefined;
  return base ? base + txHash : undefined;
}

/**
 * Solana's explorer selects the network by query parameter; mainnet is the
 * default and takes none.
 */
export function solanaExplorerUrl(signature: string, chain: string): string {
  const cluster = chain.split(":")[1];
  const suffix = cluster && cluster !== "mainnet" ? `?cluster=${cluster}` : "";
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/** Signatures arrive as raw bytes; explorers address them in base58. */
export function toBase58(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

/** Middle-truncate a long id so it stays readable on a phone. */
export function shortId(value: string, keep = 8): string {
  return value.length <= keep * 2 + 3
    ? value
    : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

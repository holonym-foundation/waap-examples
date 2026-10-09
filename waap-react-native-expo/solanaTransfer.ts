import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  address,
  createSolanaRpc,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  blockhash,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

/** 32 base58 '1's — each is one zero byte, so this decodes to 32 zero bytes. */
const PLACEHOLDER_BLOCKHASH = blockhash("11111111111111111111111111111111");

/** A visible but negligible priority fee, so the demo shows a realistic shape. */
const PRIORITY_FEE_MICROLAMPORTS = 1_000n;

/**
 * Build a native SOL transfer message offline, with no RPC call.
 *
 * The blockhash is an all-zero placeholder: WaaP splices the real one during
 * preparation, and only checks that `accountKeys[0]` is the sender. That is
 * what lets an integrator construct a transfer without running a Solana RPC
 * client of their own.
 *
 * Emits a full TRANSACTION, not a bare compiled message. `solana_signTransaction`
 * is decoded wallet-side with `getTransactionDecoder()`, which expects the
 * signature array to precede the message; handing it a bare message makes it
 * read the leading bytes as a signature count and fail with a 32-byte codec
 * error. (`buildOfflineSolMessage` in `@human.tech/waap-core` returns a message
 * because it feeds a different entry point.)
 *
 * LEGACY rather than v0: WaaP compares its spliced copy against this message,
 * and the two must use the same canonical account ordering.
 */
export function buildSolTransferMessage(args: {
  from: string;
  to: string;
  lamports: bigint;
}): Uint8Array {
  const from = address(args.from);
  const to = address(args.to);
  // The sender signs later, inside the wallet, so the account is marked as a
  // signer without a key being attached here.
  const signer = createNoopSigner(from);

  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(from, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitPriceInstruction({
            microLamports: PRIORITY_FEE_MICROLAMPORTS,
          }),
          getTransferSolInstruction({
            source: signer,
            destination: to,
            amount: args.lamports,
          }),
        ],
        m,
      ),
  );

  // The encoder returns kit's branded read-only byte array, which is a real
  // Uint8Array at runtime. The single signature slot is left empty — the
  // wallet fills it.
  return getTransactionEncoder().encode(
    compileTransaction(message),
  ) as unknown as Uint8Array;
}

/** Public RPC per chain, mirroring the wallet's own `solanaRpcUrl` mapping. */
const RPC_URLS: Record<string, string> = {
  "solana:mainnet": "https://api.mainnet-beta.solana.com",
  "solana:devnet": "https://api.devnet.solana.com",
  "solana:testnet": "https://api.testnet.solana.com",
  "solana:localnet": "http://127.0.0.1:8899",
};

/**
 * Read a Solana balance directly from the public RPC.
 *
 * The wallet does not expose a Solana balance over the bridge — `eth_getBalance`
 * has no Solana counterpart in the provider — so the demo queries the chain the
 * way any dapp would.
 */
export async function fetchSolBalance(
  addressText: string,
  chain: string,
): Promise<bigint> {
  const url = RPC_URLS[chain];
  if (!url) throw new Error(`No RPC configured for ${chain}`);
  const rpc = createSolanaRpc(url);
  const { value } = await rpc.getBalance(address(addressText)).send();
  return BigInt(value);
}

/** Lamports -> SOL, trimmed. 1 SOL = 1e9 lamports. */
export function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0");
  const shown = frac.replace(/0+$/, "");
  return shown ? `${whole}.${shown}` : `${whole}`;
}

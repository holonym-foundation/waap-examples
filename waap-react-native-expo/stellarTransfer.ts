import {
  Account,
  Asset,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-base";

export type StellarNetworkKey = "TESTNET" | "PUBLIC";

const HORIZON: Record<StellarNetworkKey, string> = {
  TESTNET: "https://horizon-testnet.stellar.org",
  PUBLIC: "https://horizon.stellar.org",
};

const PASSPHRASE: Record<StellarNetworkKey, string> = {
  TESTNET: Networks.TESTNET,
  PUBLIC: Networks.PUBLIC,
};

export const horizonUrl = (network: StellarNetworkKey) => HORIZON[network];

/** 1 XLM = 10^7 stroops, which exceeds a double's exact integer range. */
export function formatXlm(stroops: string, decimals = 7): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const frac = (value % 10_000_000n).toString().padStart(7, "0");
  const shown = frac.slice(0, decimals).replace(/0+$/, "");
  return shown ? `${whole}.${shown}` : `${whole}`;
}

/**
 * Native XLM balance, and whether the account exists at all.
 *
 * Horizon reports a never-funded account as 404. That is NOT a zero balance —
 * such an account can neither send nor receive — so the two are returned
 * separately rather than collapsed.
 */
export async function fetchXlmBalance(
  address: string,
  network: StellarNetworkKey,
): Promise<{ exists: boolean; balance: string | null }> {
  const response = await fetch(`${horizonUrl(network)}/accounts/${address}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return { exists: false, balance: null };
  if (!response.ok) throw new Error(`Horizon returned ${response.status}`);
  const account = (await response.json()) as {
    balances?: { asset_type: string; balance: string }[];
  };
  const native = account.balances?.find((b) => b.asset_type === "native");
  return { exists: true, balance: native?.balance ?? "0" };
}

/**
 * Build an unsigned payment for the wallet to sign.
 *
 * Unlike the Solana helper this cannot be built offline: Stellar requires the
 * account's exact next sequence number, and the wallet does not splice one in
 * on this path — the dapp owns the bytes and the wallet signs them as given.
 *
 * Returns the standard TransactionEnvelope for SEP-43 signing.
 */
export async function buildXlmPayment(args: {
  source: string;
  destination: string;
  amount: string;
  memo?: string;
  network: StellarNetworkKey;
}): Promise<string> {
  const response = await fetch(
    `${horizonUrl(args.network)}/accounts/${args.source}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) {
    throw new Error(
      "This Stellar account has not been created yet. Fund it from friendbot first.",
    );
  }
  if (!response.ok) throw new Error(`Horizon returned ${response.status}`);
  const account = (await response.json()) as { sequence: string };

  let builder = new TransactionBuilder(
    new Account(args.source, account.sequence),
    { fee: "100", networkPassphrase: PASSPHRASE[args.network] },
  ).addOperation(
    Operation.payment({
      destination: args.destination,
      asset: Asset.native(),
      amount: args.amount,
    }),
  );
  if (args.memo?.trim()) builder = builder.addMemo(Memo.text(args.memo.trim()));

  const built = builder.setTimeout(180).build();
  // `toXDR('base64')` calls `toString('base64')` on a `subarray()` of the
  // writer's buffer. On Hermes that subarray is a plain Uint8Array, not the
  // polyfilled Buffer, so the format argument is ignored and the bytes come
  // back comma-joined. Re-wrapping the raw bytes yields a real Buffer.
  const raw = built.toEnvelope().toXDR("raw");
  return Buffer.from(raw).toString("base64");
}

export const friendbotUrl = (address: string) =>
  `https://friendbot.stellar.org?addr=${address}`;

export function stellarExplorerUrl(
  network: StellarNetworkKey,
  txHash: string,
): string {
  const scope = network === "PUBLIC" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${scope}/tx/${txHash}`;
}

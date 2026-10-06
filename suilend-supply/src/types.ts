import type BigNumber from "bignumber.js";

/** SUI reserve state as read from chain, with interest compounded to `readAtMs`. */
export interface SuiReserveSnapshot {
  arrayIndex: bigint;
  /** Liquidity currently in the reserve (what withdrawals are paid from), MIST. */
  availableMist: bigint;
  ctokenSupply: bigint;
  /** available + borrowed − unclaimed spread fees, MIST (fractional). */
  totalSupplyMist: BigNumber;
  depositLimitMist: bigint;
  depositAprPercent: string;
}

export interface MarketSnapshot {
  lendingMarketId: string;
  lendingMarketType: string;
  /** Package id the SuiLend SDK will use for move calls (chosen from the on-chain market version). */
  publishedAt: string;
  sui: SuiReserveSnapshot;
  readAtMs: number;
}

export interface WalletSnapshot {
  address: string;
  /** SUI held in Coin<SUI> objects — the only SUI a GasCoin split can use. */
  coinObjectMist: bigint;
  /** SUI held as an address balance (not spendable by this recipe's supply PTB). */
  addressBalanceMist: bigint;
}

export interface ObligationSnapshot {
  obligationId: string;
  capId: string;
  suiCtokens: bigint;
  otherDeposits: { coinType: string; ctokens: bigint }[];
  depositCount: number;
  borrowCount: number;
}

/** Everything the chain side must provide. The production implementation is in chain.ts. */
export interface ChainPort {
  readMarket(): Promise<MarketSnapshot>;
  readWallet(address: string): Promise<WalletSnapshot>;
  readObligations(address: string): Promise<ObligationSnapshot[]>;
  /** Kind-only bytes for a transaction built by ptb.ts; object inputs resolved on chain. */
  buildKind(build: (tx: import("@mysten/sui/transactions").Transaction) => void): Promise<Uint8Array>;
  /** Simulate kind bytes as a full transaction from `sender`. */
  simulate(kind: Uint8Array, sender: string): Promise<SimulationOutcome>;
  /** Base58 genesis checkpoint digest of the network the reads come from. */
  chainIdentifier(): Promise<string>;
  /** Latest checkpoint sequence number the read node has (chain clock; follow-up 2). */
  latestCheckpoint(): Promise<bigint>;
  /**
   * Look up a submitted transaction: status, signer, gas payer and per-address SUI balance
   * changes. "not_found" only when the node says it does not know the digest; transport
   * errors throw.
   */
  transactionInfo(digest: string): Promise<TransactionInfo>;
}

export type TransactionInfo =
  | { status: "not_found" }
  | {
      status: "success" | "failure";
      sender: string;
      gasOwner: string;
      /** computation + storage − rebate, MIST (may be negative). */
      gasPaidMist: bigint;
      /** Net SUI change per normalized address, MIST. */
      suiChangeMist: Record<string, bigint>;
      /** SHA-256 (hex) of the executed transaction's TransactionKind BCS, when the read includes it. */
      kindSha256?: string;
      /** Sequence number of the checkpoint containing the transaction; undefined until checkpointed. */
      checkpoint?: bigint;
    };

export type SimulationOutcome =
  | { ok: true; gasUsedMist?: bigint }
  | { ok: false; reason: string; abort?: { module?: string; code?: string } };

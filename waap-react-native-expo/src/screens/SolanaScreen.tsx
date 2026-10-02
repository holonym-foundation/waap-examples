import React, { useEffect, useState } from "react";
import { getWaaPSolanaProvider } from "@human.tech/waap-sdk-react-native/solana";

import { solanaExplorerUrl, toBase58 } from "../../explorer";
import {
  buildSolTransferMessage,
  fetchSolBalance,
  formatSol,
} from "../../solanaTransfer";
import { SOLANA_DEVNET, SOLANA_MESSAGE } from "../workbench/fixtures";
import type { RunLog } from "../workbench/runLog";
import { Action, Screen } from "./ui";

export function SolanaScreen({
  account,
  log,
}: {
  /** The EVM account: a logout ends the Solana session with it. */
  account: string | null;
  log: RunLog;
}) {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    if (!account) setAddress(null);
  }, [account]);

  const disabled = !address;
  const sender = address ?? "";
  const selfTransfer = () =>
    buildSolTransferMessage({ from: sender, to: sender, lamports: 1n });

  return (
    <Screen
      title={address ?? "No Solana account"}
      note="Devnet. Sending needs a little devnet SOL for the fee."
    >
      <Action
        primary
        label="Connect Solana"
        log={log}
        run={async () => {
          const solana = getWaaPSolanaProvider();
          await solana.selectStandardMode();
          const connected = (await solana.connect())[0]?.address ?? null;
          setAddress(connected);
          if (!connected) return "no account";
          const lamports = await fetchSolBalance(connected, SOLANA_DEVNET);
          return `${connected} (${formatSol(lamports)} SOL)`;
        }}
      />
      <Action
        label="Sign message"
        log={log}
        disabled={disabled}
        run={async () => {
          const result = await getWaaPSolanaProvider().signMessage({
            message: new TextEncoder().encode(SOLANA_MESSAGE),
          });
          return toBase58(result.signature);
        }}
      />
      <Action
        label="Sign transfer"
        log={log}
        disabled={disabled}
        run={async () => {
          const result = await getWaaPSolanaProvider().signTransaction({
            transaction: selfTransfer(),
            chain: SOLANA_DEVNET,
          });
          return toBase58(result.signature);
        }}
      />
      <Action
        label="Send 1 lamport"
        log={log}
        disabled={disabled}
        run={async () => {
          const result = await getWaaPSolanaProvider().signAndSendTransaction({
            transaction: selfTransfer(),
            chain: SOLANA_DEVNET,
          });
          return solanaExplorerUrl(result.signature, SOLANA_DEVNET);
        }}
      />
      <Action
        label="Disconnect Solana"
        log={log}
        disabled={disabled}
        run={async () => {
          await getWaaPSolanaProvider().disconnect();
          setAddress(null);
          return "disconnected";
        }}
      />
    </Screen>
  );
}

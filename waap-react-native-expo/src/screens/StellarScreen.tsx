import React, { useState } from "react";
import {
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { getWaaPStellarProvider } from "@human.tech/waap-sdk-react-native/stellar";

import {
  type StellarNetworkKey,
  buildXlmPayment,
  fetchXlmBalance,
  friendbotUrl,
  stellarExplorerUrl,
} from "../../stellarTransfer";
import type { RunLog } from "../workbench/runLog";
import { Action, Screen } from "./ui";

const NETWORKS: readonly StellarNetworkKey[] = ["TESTNET", "PUBLIC"];
const MESSAGE = "Hello from WaaP mobile";
// The smallest amount Stellar can express: it exercises the whole path
// without moving anything meaningful.
const DUST = "0.0000001";

export function StellarScreen({
  account,
  walletLabel,
  log,
}: {
  account: string | null;
  walletLabel: string;
  log: RunLog;
}) {
  const [network, setNetwork] = useState<StellarNetworkKey>("TESTNET");
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  // Each network is its own provider handle; the toggle picks which one to ask.
  const stellar = () => getWaaPStellarProvider({ network });

  // Horizon reports a never-funded account as 404. That is NOT a zero
  // balance: such an account can neither send nor receive until funded once.
  const refreshBalance = async (target: string, on: StellarNetworkKey) => {
    const { exists, balance: xlm } = await fetchXlmBalance(target, on);
    const shown = exists ? `${xlm ?? "0"} XLM` : "not created: fund it once";
    setBalance(shown);
    return shown;
  };

  // The production wallet answers Stellar requests with an empty overlay that
  // never resolves, so nothing is sent there. Remove once Stellar ships to
  // production (`main`).
  const unsupported = walletLabel === "production";
  const disabled = !account || unsupported;
  const needsAddress = disabled || !address;

  return (
    <Screen
      title={address ?? "No Stellar address yet"}
      note={
        unsupported
          ? "The production wallet does not support Stellar yet, so these actions are off. Run with EXPO_PUBLIC_WAAP_WALLET=staging."
          : `Network ${network}. Balance: ${balance ?? "—"}. Signatures are not verified on the device.`
      }
    >
      <View style={styles.chips}>
        {NETWORKS.map((option) => (
          <TouchableOpacity
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: option === network }}
            style={[styles.chip, option === network && styles.chipSelected]}
            onPress={() => {
              setNetwork(option);
              // The old figures belong to the old network.
              setBalance(null);
              if (address) {
                void log.run(`Stellar balance (${option})`, () =>
                  refreshBalance(address, option),
                );
              }
            }}
          >
            <Text
              style={
                option === network ? styles.chipTextSelected : styles.chipText
              }
            >
              {option === "TESTNET" ? "Testnet" : "Mainnet"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Action
        label="Get Stellar address"
        log={log}
        disabled={disabled}
        run={async () => {
          await stellar().selectStandardMode();
          const { address: next } = await stellar().getAddress();
          setAddress(next);
          return `${next} · ${await refreshBalance(next, network)}`;
        }}
      />
      <Action
        label="Fund from Friendbot"
        log={log}
        disabled={needsAddress || network !== "TESTNET"}
        run={async () => {
          await Linking.openURL(friendbotUrl(address!));
          return "opened friendbot; refresh the balance once it confirms";
        }}
      />
      <Action
        label="Refresh balance"
        log={log}
        disabled={needsAddress}
        run={() => refreshBalance(address!, network)}
      />
      <Action
        label="Sign message (SEP-53)"
        log={log}
        disabled={needsAddress}
        run={async () => (await stellar().signMessage(MESSAGE)).signedMessage}
      />
      <Action
        label="Sign self-payment"
        log={log}
        disabled={needsAddress}
        run={async () => {
          const xdr = await buildXlmPayment({
            source: address!,
            destination: address!,
            amount: DUST,
            network,
          });
          // Signed but not submitted, so there is nothing on chain to link to.
          return (await stellar().signTransaction(xdr)).signedTxXdr;
        }}
      />
      <Action
        label="Send self-payment"
        log={log}
        disabled={needsAddress}
        run={async () => {
          const xdr = await buildXlmPayment({
            source: address!,
            destination: address!,
            amount: DUST,
            memo: "waap-rn",
            network,
          });
          const sent = await stellar().signTransaction(xdr, { submit: true });
          await refreshBalance(address!, network);
          return sent.hash
            ? stellarExplorerUrl(network, sent.hash)
            : sent.signedTxXdr;
        }}
      />
      <Action
        label="signAuthEntry (expect refusal)"
        log={log}
        disabled={needsAddress}
        run={async () => {
          try {
            await stellar().signAuthEntry();
          } catch (error) {
            // The refusal IS the expected outcome: Soroban entries cannot be
            // decoded or displayed, and signing a blob the user cannot see is
            // the blind signing this avoids.
            const { message } = error as { message?: string };
            return `refused, as expected: ${message ?? String(error)}`;
          }
          throw new Error("Unexpected: this should have been refused.");
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#c7d2fe",
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipSelected: { backgroundColor: "#4f46e5", borderColor: "#4f46e5" },
  chipText: { color: "#4f46e5", fontWeight: "600" },
  chipTextSelected: { color: "#ffffff", fontWeight: "600" },
});

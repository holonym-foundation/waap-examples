import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeEthereumProvider } from "@human.tech/waap-sdk-react-native";
import { getWaaPSolanaProvider } from "@human.tech/waap-sdk-react-native/solana";

import type { RunLog } from "../workbench/runLog";
import { Action, Screen } from "./ui";

// How long to keep waiting for the wallet after the login browser closes.
const AWAIT_WALLET_MS = 45_000;

export function AccountScreen({
  provider,
  account,
  log,
}: {
  provider: NativeEthereumProvider;
  account: string | null;
  log: RunLog;
}) {
  // `login()` settles with null as soon as the login browser is dismissed, and
  // Android users always dismiss it by hand, so null does not mean cancelled:
  // the wallet may still confirm, and the account then arrives through
  // `accountsChanged`. Show progress instead of the login button meanwhile.
  const [awaitingWallet, setAwaitingWallet] = useState(false);

  useEffect(() => {
    if (!awaitingWallet) return;
    if (account) {
      setAwaitingWallet(false);
      return;
    }
    const timer = setTimeout(() => setAwaitingWallet(false), AWAIT_WALLET_MS);
    return () => clearTimeout(timer);
  }, [awaitingWallet, account]);

  const waiting = awaitingWallet && !account;

  return (
    <Screen
      title={account ? `Connected: ${account}` : "Not connected"}
      note={
        Platform.OS === "android"
          ? "Social login opens a Chrome tab that Android does not let the app close: close it yourself once the wallet confirms, and the login completes in the background."
          : "Social login opens a browser that closes itself once the wallet confirms the login. If you close it sooner, the login still completes in the background."
      }
    >
      {waiting && (
        <View style={styles.waiting}>
          <ActivityIndicator />
          <Text style={styles.waitingText}>Finishing sign-in…</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setAwaitingWallet(false)}
          >
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
      )}
      {!account && !waiting && (
        <>
          <Action
            primary
            label="Log in"
            log={log}
            run={async () => {
              const method = await provider.login();
              if (method === null) setAwaitingWallet(true);
              return `login method: ${String(method)}`;
            }}
          />
          <Action
            label="Connect"
            log={log}
            run={async () => {
              const accounts = (await provider.request({
                method: "eth_requestAccounts",
              })) as string[];
              return accounts.join(", ") || "no accounts";
            }}
          />
        </>
      )}
      <Action
        label="Account status"
        log={log}
        run={async () =>
          JSON.stringify(await getWaaPSolanaProvider().getAccountStatus())
        }
      />
      {account && (
        <Action
          label="Log out"
          log={log}
          run={async () => {
            await provider.logout();
            return "logged out";
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: "center", gap: 8, paddingVertical: 12 },
  waitingText: { color: "#4b5563" },
  cancel: { color: "#4f46e5", fontWeight: "600" },
});

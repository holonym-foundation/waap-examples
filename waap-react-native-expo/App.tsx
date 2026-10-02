import React, { useEffect, useMemo, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  createInAppNativeBrowser,
  initWaapNative,
  WaaPModule,
} from "@human.tech/waap-sdk-react-native";
import type { NativeEthereumProvider } from "@human.tech/waap-sdk-react-native";
import InAppBrowser from "react-native-inappbrowser-reborn";

import { AccountScreen } from "./src/screens/AccountScreen";
import { EvmScreen } from "./src/screens/EvmScreen";
import { LogScreen } from "./src/screens/LogScreen";
import { SolanaScreen } from "./src/screens/SolanaScreen";
import { StellarScreen } from "./src/screens/StellarScreen";
import { debug, project, wallet } from "./src/workbench/config";
import { createRunLog } from "./src/workbench/runLog";

const TABS = ["Account", "EVM", "Solana", "Stellar", "Log"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const log = useMemo(createRunLog, []);
  const [provider, setProvider] = useState<NativeEthereumProvider | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Account");

  useEffect(() => {
    const waap = initWaapNative({
      ...wallet.target,
      debug,
      customConfig: {
        styles: { darkMode: false },
        showSecured: false,
        // Email's magic link cannot return to the app and phone login is
        // disabled, so neither can complete on mobile.
        authenticationMethods: ["social", "wallet"],
        allowedSocials: ["google", "twitter", "discord", "github", "bluesky"],
      },
      project,
      walletConnectProjectId: "e24feb8bc79d4998e172b2270450b0d4",
      nativeBrowser: createInAppNativeBrowser(InAppBrowser),
    });
    setProvider(waap);

    const onAccounts = (accounts: string[]) => {
      setAccount(accounts[0] || null);
      log.record("accountsChanged", true, accounts.join(", ") || "[]");
    };
    const onChain = (chainId: string) =>
      log.record("chainChanged", true, chainId);
    const onDisconnect = () => {
      setAccount(null);
      log.record("disconnect", true, "wallet disconnected");
    };
    waap.on("accountsChanged", onAccounts);
    waap.on("chainChanged", onChain);
    waap.on("disconnect", onDisconnect);

    // A passive probe: restores a signed-in session without opening login.
    void log.run("startup restore", async () => {
      const accounts = (await waap.request({
        method: "eth_accounts",
      })) as string[];
      setAccount(accounts[0] || null);
      return accounts.join(", ") || "no session";
    });

    return () => {
      waap.removeListener("accountsChanged", onAccounts);
      waap.removeListener("chainChanged", onChain);
      waap.removeListener("disconnect", onDisconnect);
    };
  }, [log]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        <Text style={styles.header}>
          WaaP React Native Example · {wallet.label}
        </Text>
        <ScrollView style={styles.body}>
          {provider && tab === "Account" && (
            <AccountScreen provider={provider} account={account} log={log} />
          )}
          {provider && tab === "EVM" && (
            <EvmScreen provider={provider} account={account} log={log} />
          )}
          {tab === "Solana" && <SolanaScreen account={account} log={log} />}
          {tab === "Stellar" && (
            <StellarScreen
              account={account}
              walletLabel={wallet.label}
              log={log}
            />
          )}
          {tab === "Log" && <LogScreen log={log} />}
        </ScrollView>
        <View style={styles.tabs}>
          {TABS.map((name) => (
            <TouchableOpacity
              key={name}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === name }}
              style={styles.tab}
              onPress={() => setTab(name)}
            >
              <Text style={tab === name ? styles.tabActive : styles.tabText}>
                {name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </SafeAreaView>
      {/* Mounted once at the root and kept mounted, so an approval in flight
          survives switching tabs. */}
      <WaaPModule />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f9fafb" },
  header: {
    fontSize: 18,
    fontWeight: "600",
    textAlign: "center",
    paddingVertical: 12,
  },
  body: { flex: 1 },
  tabs: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "#d1d5db",
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 14 },
  tabText: { color: "#6b7280" },
  tabActive: { color: "#4f46e5", fontWeight: "700" },
});

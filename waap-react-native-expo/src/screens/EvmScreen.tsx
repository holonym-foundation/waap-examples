import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { NativeEthereumProvider } from "@human.tech/waap-sdk-react-native";

import { evmExplorerUrl } from "../../explorer";
import { EVM_CHAINS, evmChain, type EvmChain } from "../workbench/chains";
import {
  LONG_PERSONAL_MESSAGE,
  SHORT_PERSONAL_MESSAGE,
  nestedTypedData,
  selfTransfer,
  simpleTypedData,
  utf8Hex,
  verifyPersonalSign,
  verifyTypedDataSignature,
  type WireTypedData,
} from "../workbench/fixtures";
import type { RunLog } from "../workbench/runLog";
import { Action, Screen } from "./ui";

const verdict = (ok: boolean) => (ok ? "verified" : "DOES NOT VERIFY");

export function EvmScreen({
  provider,
  account,
  log,
}: {
  provider: NativeEthereumProvider;
  account: string | null;
  log: RunLog;
}) {
  const [chainId, setChainId] = useState<string | null>(null);
  const chain = evmChain(chainId);
  const disabled = !account;
  const signer = account ?? "";

  useEffect(() => {
    if (!account) return;
    const onChain = (id: string) => setChainId(id);
    provider.on("chainChanged", onChain);
    provider
      .request({ method: "eth_chainId" })
      .then((id) => setChainId(String(id)))
      .catch(() => setChainId(null));
    return () => {
      provider.removeListener("chainChanged", onChain);
    };
  }, [provider, account]);

  const switchTo = (target: EvmChain) =>
    void log.run(`switch to ${target.label}`, async () => {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: target.id }],
      });
      const id = String(await provider.request({ method: "eth_chainId" }));
      setChainId(id);
      return `chain ${id}`;
    });

  const personalSign = async (message: string) => {
    const signature = (await provider.request({
      method: "personal_sign",
      params: [utf8Hex(message), signer],
    })) as string;
    const ok = await verifyPersonalSign(signer, message, signature);
    return `${verdict(ok)} ${signature}`;
  };

  const signTypedData = async (typedData: WireTypedData) => {
    const signature = (await provider.request({
      method: "eth_signTypedData_v4",
      params: [signer, JSON.stringify(typedData)],
    })) as string;
    const ok = await verifyTypedDataSignature(signer, typedData, signature);
    return `${verdict(ok)} ${signature}`;
  };

  const title = !account
    ? "Connect on the Account tab first"
    : chain
      ? chain.label
      : `Unlisted chain ${chainId ?? "…"}: pick one below`;

  return (
    <Screen
      title={title}
      note="Signatures are verified on the device against the connected address."
    >
      <View style={styles.chains}>
        {EVM_CHAINS.map((option) => (
          <TouchableOpacity
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: option.id === chain?.id }}
            disabled={disabled}
            style={[
              styles.chip,
              option.id === chain?.id && styles.chipSelected,
              disabled && styles.chipDisabled,
            ]}
            onPress={() => switchTo(option)}
          >
            <Text
              style={
                option.id === chain?.id
                  ? styles.chipTextSelected
                  : styles.chipText
              }
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Action
        label="Sign short message"
        log={log}
        disabled={disabled}
        run={() => personalSign(SHORT_PERSONAL_MESSAGE)}
      />
      <Action
        label="Sign long message"
        log={log}
        disabled={disabled}
        run={() => personalSign(LONG_PERSONAL_MESSAGE)}
      />
      <Action
        label="Sign typed data"
        log={log}
        disabled={disabled || !chain}
        run={() => signTypedData(simpleTypedData(chain!.chainId))}
      />
      <Action
        label="Sign nested typed data"
        log={log}
        disabled={disabled || !chain}
        run={() => signTypedData(nestedTypedData(signer, chain!.chainId))}
      />
      <Action
        label={
          chain && !chain.canSend
            ? `Sending disabled on ${chain.label}`
            : "Send 0 ETH to self"
        }
        log={log}
        disabled={disabled || !chain?.canSend}
        run={async () => {
          const hash = (await provider.request({
            method: "eth_sendTransaction",
            params: [selfTransfer(signer)],
          })) as string;
          return evmExplorerUrl(chain!.id, hash) ?? hash;
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chains: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#c7d2fe",
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  chipSelected: { backgroundColor: "#4f46e5", borderColor: "#4f46e5" },
  chipDisabled: { opacity: 0.4 },
  chipText: { color: "#4f46e5", fontWeight: "600" },
  chipTextSelected: { color: "#ffffff", fontWeight: "600" },
});

type WalletTarget = { environment: "production" | "staging" };

/**
 * Which WaaP wallet the example drives, fixed when Metro bundles:
 *   EXPO_PUBLIC_WAAP_WALLET=staging  https://staging.waap.xyz
 *   unset                            https://waap.xyz
 * Accounts do not carry over between the two.
 */
export function walletTarget(wallet: string | undefined): {
  label: string;
  target: WalletTarget;
} {
  if (wallet === "staging") {
    return { label: "staging", target: { environment: "staging" } };
  }
  return { label: "production", target: { environment: "production" } };
}

export const wallet = walletTarget(process.env.EXPO_PUBLIC_WAAP_WALLET);

/** Forwards the wallet page's console into Metro, prefixed `[WebView]`. */
export const debug = process.env.EXPO_PUBLIC_WAAP_DEBUG === "true";

export const project = {
  appId: "tech.human.waap.example.rn",
  name: "WaaP React Native Example",
  // `app.json`'s `scheme`: Expo registers it on both platforms, and the login
  // session returns to it.
  nativeRedirect: "waaprnexample://",
  // The origin the wallet scopes this app's grants to. Set it to a domain you
  // control; the default is a placeholder that does not resolve.
  universalRedirect:
    process.env.EXPO_PUBLIC_WAAP_UNIVERSAL_REDIRECT ?? "https://example.com",
};

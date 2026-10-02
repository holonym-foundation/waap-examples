# WaaP + React Native (Expo)

An iOS and Android app built on
[`@human.tech/waap-sdk-react-native`](https://www.npmjs.com/package/@human.tech/waap-sdk-react-native):
social and wallet login, session restore, and EVM, Solana and Stellar
signing. Each screen is a thin layer over one SDK call, so the code reads as a
reference for wiring WaaP into your own app.

## Run

The SDK uses native modules (Keychain, WebView, the in-app browser), so this
runs as a development build, not in Expo Go.

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-react-native-expo
cd waap-react-native-expo
pnpm install
pnpm ios        # or: pnpm android
```

You need Xcode for iOS, or Java 17 and the Android SDK for Android. Expo
generates the native projects from `app.json` on the first run.

On Xcode 27, `pnpm ios` stops with "Can't determine id of Simulator app"
(Xcode renamed the Simulator app). Build with `xcodebuild` instead, then
install with `xcrun simctl install` and keep `pnpm start` running for Metro:

```bash
cd ios && xcodebuild -workspace *.xcworkspace -scheme WaaPRNExample \
  -sdk iphonesimulator -destination id=<simulator-udid> -derivedDataPath build \
  CODE_SIGN_IDENTITY=- build
```

`CODE_SIGN_IDENTITY=-` matters: without it the simulator app has no Keychain
entitlement, and the wallet cannot store its keys.

| Variable                              | Default               | Purpose                                                                     |
| ------------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `EXPO_PUBLIC_WAAP_WALLET`             | unset (production)    | `staging` drives `staging.waap.xyz` instead of `waap.xyz`                   |
| `EXPO_PUBLIC_WAAP_UNIVERSAL_REDIRECT` | `https://example.com` | Origin the wallet scopes your app's grants to: **use a domain you control** |
| `EXPO_PUBLIC_WAAP_DEBUG`              | unset                 | `true` forwards the wallet page's console into Metro                        |

Accounts do not carry over between production and staging: an account that
signs in on one gets "Account not found" on the other until it is created
there.

## Integrate WaaP in your app

1. **Initialise once** and mount `WaaPModule` at the root, kept mounted: the
   wallet runs in its WebView.

   ```tsx
   import {
     createInAppNativeBrowser,
     initWaapNative,
     WaaPModule,
   } from "@human.tech/waap-sdk-react-native";
   import InAppBrowser from "react-native-inappbrowser-reborn";

   const provider = initWaapNative({
     environment: "production",
     project: {
       appId: "com.example.app",
       name: "My App",
       // A scheme your app registers (`scheme` in app.json). The login
       // session returns to it.
       nativeRedirect: "myapp://",
       universalRedirect: "https://myapp.example",
     },
     customConfig: { authenticationMethods: ["social", "wallet"] },
     // External-wallet login uses WalletConnect: get a project ID at
     // https://cloud.reown.com. This example ships with the WaaP demo's ID.
     walletConnectProjectId: "your-walletconnect-project-id",
     nativeBrowser: createInAppNativeBrowser(InAppBrowser),
   });

   export default function App() {
     return (
       <>
         {/* your screens */}
         <WaaPModule />
       </>
     );
   }
   ```

2. **Restore without prompting** at launch, then log in on a tap:

   ```ts
   const [account] = (await provider.request({
     method: "eth_accounts",
   })) as string[];
   if (!account) await provider.login();
   ```

3. **Sign** with standard EIP-1193 requests. Typed data goes as a JSON string,
   and its `domain.chainId` must match the wallet's current chain:

   ```ts
   await provider.request({
     method: "eth_signTypedData_v4",
     params: [account, JSON.stringify(typedData)],
   });
   ```

   Solana and Stellar have their own providers:
   `getWaaPSolanaProvider()` from `@human.tech/waap-sdk-react-native/solana`
   and `getWaaPStellarProvider({ network })` from `…/stellar`.

## Configuration this app needs

- **Login methods:** social and external wallet. Email's magic link cannot
  return to the app, and phone login is disabled.
- **External wallets:** `app.json` lists wallet URL schemes
  (`LSApplicationQueriesSchemes`) on iOS. `android-wallet-queries.js` adds
  wallet packages to Android's `<queries>`, merged with what other plugins
  declare (the in-app browser needs its own queries on Android 11+).
- **iOS pods:** `ios-pod-deployment-target.js` raises every pod's iOS
  deployment target to 15.1. Xcode 27 accepts 15.0 and later, and some pods
  (react-native-svg, async-storage) still declare 12.4 and 13.4.
- **Metro:** `metro.config.js` applies `withWaapMetroConfig` from the SDK, which
  resolves viem's and ox's ESM entry points.
- **Stellar:** `polyfills.js` installs `Buffer`, which `@stellar/stellar-base`
  needs.

## What the app shows

Each button shows its result underneath it; the Log tab keeps the history.

- **Account:** log in, connect, account status, log out; silent restore at
  launch.
- **EVM:** Sepolia, Base Sepolia and Ethereum; short and long
  `personal_sign` and simple and nested EIP-712 on the selected chain, each
  verified on the device against the connected address; send 0 ETH to self on
  testnets only.
- **Solana (devnet):** connect, sign a message, sign and send a 1-lamport
  self-transfer.
- **Stellar (SEP-43):** address, Friendbot funding, SEP-53 message, and a
  0.0000001 XLM self-payment. **Off on production for now:** the production
  wallet does not support Stellar yet, so the tab disables itself there; use
  `EXPO_PUBLIC_WAAP_WALLET=staging`. Once Stellar ships to production, delete
  the `unsupported` check in `src/screens/StellarScreen.tsx`.

## Tests

```bash
pnpm test         # fixtures, chains, signature verification, config, run log, Android queries
pnpm type-check
```

## Verified

Run on 2 October 2026 against the production wallet: iOS simulator (iPhone 17
Pro, Xcode 27) and Android emulator (Pixel 8, Android 16).

| Flow                                         | iOS | Android |
| -------------------------------------------- | --- | ------- |
| Google login                                 | ✅  | ✅      |
| "Finishing sign-in…" until the account shows | —   | ✅      |
| Restore an existing session at launch        | —   | —       |
| Switch EVM chains                            | ✅  | ✅      |
| EVM `personal_sign`, verified on the device  | ✅  | ✅      |
| EVM typed data, simple and nested            | ✅  | —       |
| Solana connect and sign message              | ✅  | ✅      |
| EVM / Solana sends                           | —   | —       |
| Stellar (needs the staging wallet)           | —   | —       |

— means not run.

## Notes

- **SDK version:** pinned to `1.1.0-staging-55513d1ba`, a pre-release that
  includes the iOS login and session-restore fixes. Move to the stable `1.1.0`
  once it is published.
- **Android login:** Android does not let an app close the login Chrome tab;
  close it once the wallet confirms, and the login completes in the
  background. iOS closes it automatically.
- **Trust model:** the wallet runs in a WebView your app controls, and the
  origin it reports is self-asserted by your app.

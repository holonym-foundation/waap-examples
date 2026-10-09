// Expo config plugin to add wallet package queries to AndroidManifest.xml
// This allows the app to detect which wallets are installed on the device
// Based on: https://github.com/expo/config-plugins/issues/123#issuecomment-1746757954

const {
  AndroidConfig,
  withAndroidManifest,
  createRunOncePlugin,
} = require("expo/config-plugins");

// List of wallet packages to detect
const queries = {
  package: [
    { $: { "android:name": "io.metamask" } },
    { $: { "android:name": "com.wallet.crypto.trustapp" } },
    { $: { "android:name": "io.gnosis.safe" } },
    { $: { "android:name": "me.rainbow" } },
    { $: { "android:name": "com.uniswap.mobile" } },
    { $: { "android:name": "io.zerion.android" } },
    // Add more wallet package names as needed
  ],
};

/**
 * Adds wallet package queries to the Android manifest
 * @param {import('@expo/config-plugins').ExportedConfig} config
 */
/**
 * Add the wallet packages to the manifest's existing <queries>. Replacing the
 * block dropped what other plugins declared, including expo-web-browser's
 * Custom Tabs query, without which Android 11+ cannot find the login browser.
 */
const mergeWalletQueries = (manifest) => ({
  ...manifest,
  queries: [...(manifest.queries ?? []), queries],
});

const withAndroidWalletQueries = (config) => {
  return withAndroidManifest(config, (config) => {
    config.modResults.manifest = mergeWalletQueries(config.modResults.manifest);
    return config;
  });
};

module.exports = createRunOncePlugin(
  withAndroidWalletQueries,
  "withAndroidWalletQueries",
  "1.0.0",
);

module.exports.mergeWalletQueries = mergeWalletQueries;

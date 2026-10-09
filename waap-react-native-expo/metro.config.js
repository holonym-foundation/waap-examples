const { getDefaultConfig } = require("expo/metro-config");
const {
  withWaapMetroConfig,
} = require("@human.tech/waap-sdk-react-native/metro-plugin");

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push("mjs", "cjs");
config.resolver.resolverMainFields = ["react-native", "browser", "main"];

// Resolves viem's and ox's TypeScript ESM entry points for Metro.
module.exports = withWaapMetroConfig(config);

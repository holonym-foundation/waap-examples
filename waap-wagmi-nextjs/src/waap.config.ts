import { InitWaaPOptions } from "@silk-wallet/silk-wallet-sdk";

export const WaaPConfig: InitWaaPOptions = {
  useStaging: false, // Set to false for production
  config: {
    allowedSocials: ["google", "twitter", "discord", "github"],
    // as we are using wagmi, we don't need to add wallet to the authentication methods
    // use walletConnect wagmi connector instead
    authenticationMethods: ["email", "phone", "social"],
    styles: {
      darkMode: false,
    },
  },
  project: {
    entryTitle: "Welcome Human",
  },
  // not needed if you are not using walletConnect
  // walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, 
};

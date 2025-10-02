import { InitSilkOptions as InitWaaPOptions } from "@silk-wallet/silk-wallet-sdk";

export const WaaPConfig: InitWaaPOptions = {
  useStaging: true,
  // useProd: true,
  config: {
    allowedSocials: ["google", "twitter", "discord", "github"],
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

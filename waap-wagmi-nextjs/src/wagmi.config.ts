import { http, createConfig } from "wagmi";
import { sepolia, mainnet, optimism, base, baseSepolia } from "wagmi/chains";
import WaaPConnector from "./waap.connector";
import { walletConnect } from "wagmi/connectors";
import { WaaPConfig } from "./waap.config";

export const config = createConfig({
  chains: [mainnet, sepolia, base, baseSepolia, optimism],
  connectors: [
    WaaPConnector(WaaPConfig),
    // walletConnect({
    //   projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
    // }),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [base.id]: http(),
    [baseSepolia.id]: http(),
    [optimism.id]: http(),
  },
});

export function getConfig() {
  return config;
}

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof getConfig>;
  }
}

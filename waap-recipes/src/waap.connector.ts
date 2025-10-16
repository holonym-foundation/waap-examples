import { ChainNotConfiguredError, createConnector, Connector } from "wagmi";
import { getAddress, SwitchChainError, UserRejectedRequestError } from "viem";

import {
  type CredentialType,
  type WaaPEthereumProviderInterface,
  WAAP_METHOD,
  initWaaP,
} from "@human.tech/waap-sdk";
import type { InitWaaPOptions } from "@human.tech/waap-sdk";

// Re-export LoginResponse type for convenience
export type LoginResponse = 'human' | 'injected' | 'walletconnect' | null;

/**
 * Extended connector type that includes WaaP-specific methods
 * Based on WaaPEthereumProviderInterface from @human.tech/waap-sdk
 */
export interface WaaPConnector extends Connector {
  // WaaP-specific properties
  isWaaP: boolean
  connected: boolean
  
  // Authentication methods
  login(customProvider?: unknown): Promise<LoginResponse>
  logout(): Promise<unknown>
  getLoginMethod(): LoginResponse
  
  // Credential methods
  requestEmail(): Promise<unknown>
  requestSBT(type: CredentialType): Promise<unknown>
  
  // UI methods
  toggleDarkMode(): Promise<void>
}

/**
 * Type guard to check if a connector is a WaaP connector
 */
export function isWaaPConnector(connector: Connector | undefined): connector is WaaPConnector {
  return connector?.id === 'waap'
}

/**
 * Creates a WAGMI connector for the WaaP SDK
 * @param options the initialization options passed to the WaaP SDK
 * @returns
 */
export default function WaaPConnector(options?: InitWaaPOptions) {
  let WaaPProvider: WaaPEthereumProviderInterface | null = null;

  return createConnector<WaaPEthereumProviderInterface>((config) => {
    console.log("WaaP Connector Config:", config);
    return {
      id: "waap",
      name: "WaaP Connector",
      type: "WaaP",
      chains: config.chains,
      supportsSimulation: false,
      

      async connect({ chainId, withCapabilities = false }: { chainId?: number; withCapabilities?: boolean } = {}) {
        try {
          config.emitter.emit("message", {
            type: "connecting",
          });
          const provider = await this.getProvider() as WaaPEthereumProviderInterface;

          provider.on("accountsChanged", this.onAccountsChanged);
          provider.on("chainChanged", this.onChainChanged);
          provider.on("disconnect", this.onDisconnect);

          if (!provider.connected) {
            try {
              await provider.login();
            } catch (error) {
              console.warn("Unable to login", error);
              throw new UserRejectedRequestError(
                "User rejected login or login failed" as unknown as Error
              );
            }
          }

          let currentChainId = await this.getChainId();
          if (chainId && currentChainId !== chainId) {
            console.info(
              `Switching chain from ${currentChainId} to ${chainId}`
            );
            const chain = await this.switchChain!({ chainId }).catch(
              (error) => {
                if (error.code === UserRejectedRequestError.code) throw error;
                return { id: currentChainId };
              }
            );
            currentChainId = chain?.id ?? currentChainId;
          }

          const accounts = await this.getAccounts();

          // If no valid accounts, throw an error to prevent connection
          if (!accounts || accounts.length === 0) {
            throw new UserRejectedRequestError(
              "No valid accounts found" as unknown as Error
            );
          }

          return { 
            accounts: withCapabilities 
              ? accounts.map(account => ({ address: account, capabilities: {} })) as any
              : accounts as any, 
            chainId: currentChainId 
          };
        } catch (error) {
          console.error("Error while connecting", error);
          this.onDisconnect();
          throw error;
        }
      },

      async getAccounts() {
        try {
          const provider = await this.getProvider() as WaaPEthereumProviderInterface;
          const accounts = await provider.request({
            method: WAAP_METHOD.eth_accounts,
          });

          if (accounts && Array.isArray(accounts)) {
            return accounts
              .filter((x: string) => x && x.trim() !== '') // Filter out empty strings
              .map((x: string) => {
                try {
                  return getAddress(x);
                } catch (error) {
                  console.warn('Invalid address received:', x, error);
                  return null;
                }
              })
              .filter((x) => x !== null); // Remove null values
          }
          return [];
        } catch (error) {
          console.warn('Error getting accounts:', error);
          return [];
        }
      },

      async getChainId() {
        const provider = await this.getProvider() as WaaPEthereumProviderInterface;
        const chainId = await provider.request({
          method: WAAP_METHOD.eth_chainId,
        });
        return Number(chainId);
      },

      async getProvider(): Promise<WaaPEthereumProviderInterface> {
        if (!WaaPProvider) {
          console.log("Initializing WaaP Provider with options:", options);
          WaaPProvider = initWaaP(options ?? {});
        }

        return WaaPProvider;
      },

      async isAuthorized() {
        try {
          const accounts = await this.getAccounts();
          // Only return true if we have valid accounts
          return accounts && accounts.length > 0;
        } catch (error) {
          console.warn('Error checking authorization:', error);
          return false;
        }
      },

      async switchChain({ chainId }) {
        console.info("Switching chain to ID", chainId);
        try {
          const chain = config.chains.find((x) => x.id === chainId);
          if (!chain) throw new ChainNotConfiguredError();

          const provider = await this.getProvider() as WaaPEthereumProviderInterface;
          await provider.request({
            method: WAAP_METHOD.wallet_switchEthereumChain,
            params: [{ chainId: `0x${chain.id.toString(16)}` }],
          });
          config.emitter.emit("change", { chainId });
          return chain;
        } catch (error: unknown) {
          console.error("Error: Unable to switch chain", error);
          throw new SwitchChainError(error as Error);
        }
      },

      async disconnect(): Promise<void> {
        const provider = await this.getProvider() as WaaPEthereumProviderInterface;

        // we need to call logout to clear the user session
        provider.logout();

        provider.removeListener("accountsChanged", this.onAccountsChanged);
        provider.removeListener("chainChanged", this.onChainChanged);
        provider.removeListener("disconnect", this.onDisconnect);
      },

      async requestEmail(): Promise<unknown> {
        const provider = await this.getProvider() as WaaPEthereumProviderInterface;
        return provider.requestEmail();
      },

      async requestSBT(type: CredentialType): Promise<unknown> {
        const provider = await this.getProvider() as WaaPEthereumProviderInterface;
        return (provider as unknown as { requestSBT: (type: CredentialType) => Promise<unknown> }).requestSBT(type);
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) {
          config.emitter.emit("disconnect");
        } else {
          const validAccounts = accounts
            .filter((x: string) => x && x.trim() !== '') // Filter out empty strings
            .map((x: string) => {
              try {
                return getAddress(x);
              } catch (error) {
                console.warn('Invalid address in accounts changed:', x, error);
                return null;
              }
            })
            .filter((x) => x !== null); // Remove null values
          
          if (validAccounts.length > 0) {
            config.emitter.emit("change", {
              accounts: validAccounts,
            });
          } else {
            config.emitter.emit("disconnect");
          }
        }
      },

      onChainChanged(chain) {
        const chainId = Number(chain);
        config.emitter.emit("change", { chainId });
      },

      onDisconnect(): void {
        config.emitter.emit("disconnect");
      },
    };
  });
}

// Supported chains configuration
export const chains = {
  sepolia: {
    id: 11155111,
    name: 'Sepolia',
    rpcUrl: 'https://sepolia.infura.io/v3/',
  },
  mainnet: {
    id: 1,
    name: 'Ethereum',
    rpcUrl: 'https://mainnet.infura.io/v3/',
  },
  optimism: {
    id: 10,
    name: 'Optimism',
    rpcUrl: 'https://optimism-mainnet.infura.io/v3/',
  },
  zksync: {
    id: 324,
    name: 'zkSync Era',
    rpcUrl: 'https://mainnet.era.zksync.io',
  },
  polygon: {
    id: 137,
    name: 'Polygon',
    rpcUrl: 'https://polygon-mainnet.infura.io/v3/',
  },
  gnosis: {
    id: 100,
    name: 'Gnosis',
    rpcUrl: 'https://rpc.gnosischain.com',
  },
  baseSepolia: {
    id: 84532,
    name: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
  },
} as const;

export type ChainId = keyof typeof chains;

// Helper function to get chain info by ID
export function getChainById(chainId: number) {
  return Object.values(chains).find(chain => chain.id === chainId);
}

// Helper function to get chain info by name
export function getChainByName(chainName: string) {
  return Object.values(chains).find(chain => chain.name === chainName);
}

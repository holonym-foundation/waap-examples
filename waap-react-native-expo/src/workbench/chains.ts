export type EvmChain = {
  id: `0x${string}`;
  chainId: number;
  label: string;
  /** Real-funds networks are for signing only, as on the web demo. */
  canSend: boolean;
};

// The web demo's networks, minus its local Hardhat chain and BSC Testnet,
// which the production wallet refuses ("Invalid chain ID").
export const EVM_CHAINS: readonly EvmChain[] = [
  { id: "0xaa36a7", chainId: 11155111, label: "Sepolia", canSend: true },
  { id: "0x14a34", chainId: 84532, label: "Base Sepolia", canSend: true },
  { id: "0x1", chainId: 1, label: "Ethereum", canSend: false },
];

export const evmChain = (id: string | null | undefined): EvmChain | undefined =>
  EVM_CHAINS.find((chain) => chain.id === id?.toLowerCase());

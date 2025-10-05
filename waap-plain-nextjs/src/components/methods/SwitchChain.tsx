import { useWaaP } from '@/waap.context'

// Define supported chains
const chains = [
  { id: 1, name: 'Ethereum Mainnet' },
  { id: 11155111, name: 'Sepolia' },
  { id: 10, name: 'Optimism' },
  { id: 324, name: 'zkSync Era' },
  { id: 137, name: 'Polygon' },
  { id: 100, name: 'Gnosis' },
  { id: 84532, name: 'Base Sepolia' },
]

export function SwitchChain() {
  const { chainId, isInitialized } = useWaaP()

  const handleChainChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedChainId = parseInt(event.target.value)
    if (selectedChainId && selectedChainId !== chainId) {
      window.waap?.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${selectedChainId.toString(16)}` }]
      })
    }
  }

  const currentChain = chains.find(chain => chain.id === chainId)

  return (
    <div className="flex flex-col gap-2">
      <h3 className='text-[16px] font-medium mb-2'>Switch Chain</h3>
      <p className="text-sm text-gray-600">Connected to: {currentChain?.name || 'Unknown'}</p>
      <select
        value={chainId || ''}
        onChange={handleChainChange}
        disabled={!isInitialized}
        className="w-full p-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
      >
        <option value="" disabled>
          Select a chain...
        </option>
        {chains.map((chain) => (
          <option key={chain.id} value={chain.id}>
            {chain.name}
          </option>
        ))}
      </select>
    </div>
  )
} 
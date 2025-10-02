import { useAccount, useSwitchChain, useConfig } from 'wagmi'

export function SwitchChain() {
  const { chain } = useAccount()
  const { switchChain } = useSwitchChain()
  const config = useConfig()

  // Get allowed chains from wagmi config
  const chains = config.chains

  const handleChainChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedChainId = parseInt(event.target.value)
    if (selectedChainId && selectedChainId !== chain?.id) {
      // Find the chain object to ensure it's a valid chain ID
      const selectedChain = chains.find(c => c.id === selectedChainId)
      if (selectedChain) {
        switchChain({ chainId: selectedChainId as typeof selectedChain.id })
      }
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className='text-[16px] font-medium mb-2'>Switch Chain</h3>
      <p className="text-sm text-gray-600">Connected to: {chain?.name}</p>
      <select
        value={chain?.id || ''}
        onChange={handleChainChange}
        className="w-full p-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
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
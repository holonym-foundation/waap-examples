import { chains } from '@/ethers.config'
import { useWaaP } from '@/waap.context'
import { useToast } from '@/hooks/useToast'
import { useState } from 'react'

export function SwitchChain() {
  const notify = useToast()
  const [isSwitching, setIsSwitching] = useState(false)

  const { isConnected, chainId, provider } = useWaaP()

  const handleChainChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }
    
    const selectedChainId = parseInt(event.target.value)
    if (selectedChainId && selectedChainId !== chainId) {
      setIsSwitching(true)
      try {
        await provider?.send('wallet_switchEthereumChain', [{ chainId: `0x${selectedChainId.toString(16)}` }])
        const selectedChain = Object.values(chains).find(chain => chain.id === selectedChainId)
        notify('success', `Switched to ${selectedChain?.name || 'Unknown chain'}`)
      } catch (error: unknown) {
        console.error('Failed to switch chain:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        notify('error', `Failed to switch chain: ${errorMessage}`)
      } finally {
        setIsSwitching(false)
      }
    }
  }

  const currentChain = Object.values(chains).find(chain => chain.id === chainId)

  return (
    <div className="flex flex-col gap-2">
      <h3 className='text-[16px] font-medium mb-2'>Switch Chain</h3>
      <p className="text-sm text-gray-600">
        Connected to: {currentChain?.name || 'Unknown'}
        {isSwitching && <span className="ml-2 text-blue-600">(Switching...)</span>}
      </p>
      <select
        value={chainId || ''}
        onChange={handleChainChange}
        disabled={isSwitching}
        className="w-full p-2 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="" disabled>
          Select a chain...
        </option>
        {Object.values(chains).map((chain) => (
          <option key={chain.id} value={chain.id}>
            {chain.name}
          </option>
        ))}
      </select>
    </div>
  )
} 
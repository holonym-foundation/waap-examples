import { useState, useEffect } from 'react'
import { useWalletClient } from 'wagmi'
import { buildSmartAccountClient, publicClient } from '@/lib/permissionless'

export function useSmartAccount() {
  const { data: walletClient } = useWalletClient()
  const [smartAccountClient, setSmartAccountClient] = useState<any>(null)
  const [smartAddress, setSmartAddress] = useState<string | null>(null)
  const [isDeployed, setIsDeployed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    async function init() {
      if (!walletClient) {
        setSmartAccountClient(null)
        setSmartAddress(null)
        return
      }
      
      try {
        setIsLoading(true)
        console.log('Initializing Smart Account with wallet:', walletClient.account.address)
        
        const client = await buildSmartAccountClient(walletClient)
        setSmartAccountClient(client)
        setSmartAddress(client.account.address)
        
        // Check if deployed
        const code = await publicClient.getBytecode({ address: client.account.address })
        setIsDeployed(!!code)
        
        console.log('Smart Account initialized:', client.account.address)
      } catch (err: any) {
        console.error('Failed to init smart account:', err)
        setError(err)
      } finally {
        setIsLoading(false)
      }
    }

    init()
  }, [walletClient])

  const refetch = async () => {
    if (smartAccountClient && smartAccountClient.account) {
      const code = await publicClient.getBytecode({ address: smartAccountClient.account.address })
      setIsDeployed(!!code)
    }
  }

  return {
    smartAccountClient,
    smartAddress,
    isDeployed,
    isLoading,
    error,
    refetch
  }
}

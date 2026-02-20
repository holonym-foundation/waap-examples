'use client'

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react'
import { useToast } from '@/hooks/useToast'
import { BrowserProvider, JsonRpcSigner } from 'ethers'
import { CredentialType, initWaaP, WAAP_METHOD, WaaPEthereumProviderInterface } from '@human.tech/waap-sdk'
import { WaaPConfig } from '@/waap.config'

/**
 * Extended ethers BrowserProvider that includes custom WaaP methods
 */
export class WaaPEthersProvider extends BrowserProvider {
  private WaaPProvider: WaaPEthereumProviderInterface

  constructor(WaaPProvider: WaaPEthereumProviderInterface) {
    super(WaaPProvider)
    this.WaaPProvider = WaaPProvider
  }

  async getLoginMethod() {
    return this.WaaPProvider.getLoginMethod()
  }
  
  async requestEmail() {
    return this.WaaPProvider.requestEmail()
  }

  async requestSBT(type: CredentialType) {
    return this.WaaPProvider.requestSBT(type)
  }

  async toggleDarkMode() {
    return this.WaaPProvider.toggleDarkMode()
  }

  async login() {
    return this.WaaPProvider.login()
  }

  async logout() {
    return this.WaaPProvider.logout()
  }

  getWaaPProvider() {
    return this.WaaPProvider
  }

  /**
   * Add event listeners for WaaP-specific events
   */
  addWaaPEventListener(event: string, listener: (...args: unknown[]) => void) {
    return this.WaaPProvider.on(event, listener)
  }

  /**
   * Remove event listeners
   */
  removeWaaPEventListener(event: string, listener: (...args: unknown[]) => void) {
    return this.WaaPProvider.removeListener?.(event, listener)
  }
}

// Initialize WaaP provider once
let WaaPProviderInstance: WaaPEthereumProviderInterface | null = null
const getWaaPProvider = () => {
  if (!WaaPProviderInstance) {
    WaaPProviderInstance = initWaaP(WaaPConfig)
  }
  return WaaPProviderInstance
}

// Context type - only the essentials
interface WaaPContextType {
  // Wallet state
  isConnected: boolean
  address: string | null
  chainId: number | null

  // Extended ethers provider with WaaP methods and signer
  provider: WaaPEthersProvider | null
  signer: JsonRpcSigner | null

  // Loading states
  isLoading: boolean
  isConnecting: boolean
  error: string | null
  
  // Actions
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

const WaaPContext = createContext<WaaPContextType | undefined>(undefined)

interface WaaPProviderProps {
  children: ReactNode
}

export function WaaPProvider({ children }: WaaPProviderProps) {
  // Simple state
  const [isConnected, setIsConnected] = useState(false)
  const [address, setAddress] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [provider, setProvider] = useState<WaaPEthersProvider | null>(null)
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const notify = useToast()
  const hasAttemptedInitialConnection = useRef(false)

  const connect = useCallback(async (autoConnect = false) => {
    // Prevent duplicate connections
    if (isConnected && !autoConnect) {
      console.log('Already connected, skipping duplicate connect call')
      return
    }
    
    setIsConnecting(!autoConnect)
    setIsLoading(autoConnect)
    setError(null)
    
    try {
      const WaaPProvider = getWaaPProvider()
      
      // For explicit connect, call login then eth_requestAccounts
      if (!autoConnect) {
        await WaaPProvider.login()
      }
      
      const accounts = await WaaPProvider.request({ 
        method: WAAP_METHOD.eth_requestAccounts 
      }) as string[]
      const chainId = await WaaPProvider.request({ method: WAAP_METHOD.eth_chainId }) as string
      
      console.log('eth_requestAccounts:', accounts)
      
      if (!accounts || accounts.length === 0 || !accounts[0] || accounts[0].trim() === '') {
        if (!autoConnect) {
          throw new Error('No accounts found')
        }
        return // Auto-connect check found no connection, that's okay
      }

      // Create extended ethers provider with WaaP methods
      const ethersProvider = new WaaPEthersProvider(WaaPProvider)
      const ethersSigner = await ethersProvider.getSigner()

      // Update state
      setAddress(accounts[0])
      setChainId(Number(chainId))
      setProvider(ethersProvider)
      setSigner(ethersSigner)
      setIsConnected(true)
      
      if (!autoConnect) {
        notify('success', 'Wallet connected successfully!')
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet'
      setError(errorMessage)
      
      if (!autoConnect) {
        console.error('Connection failed:', error)
        notify('error', errorMessage)
      } else {
        console.log('No existing connection:', errorMessage)
      }
    } finally {
      setIsConnecting(false)
      setIsLoading(false)
    }
  }, [notify, isConnected])

  // Check for existing connection on mount
  useEffect(() => {
    if (!hasAttemptedInitialConnection.current) {
      hasAttemptedInitialConnection.current = true
      connect(true) // Auto-connect check
    }
  }, [connect])

  // Set up event listeners on the WaaPEthersProvider when it's available
  useEffect(() => {
    if (!provider) return

    const handleAccountsChanged = (accounts: string[]) => {
      console.log('WaaPEthersProvider - Accounts changed:', accounts)
      if (accounts.length > 0 && accounts[0] && accounts[0].trim() !== '') {
        setAddress(accounts[0])
        setIsConnected(true)
      } else {
        setAddress(null)
        setIsConnected(false)
        setProvider(null)
        setSigner(null)
      }
    }

    const handleChainChanged = (chainId: string) => {
      console.log('WaaPEthersProvider - Chain changed:', chainId)
      setChainId(Number(chainId))
    }

    const onAccountsChanged = (accounts: unknown) => {
      handleAccountsChanged(accounts as string[])
    }

    const onChainChanged = (chainId: unknown) => {
      handleChainChanged(chainId as string)
    }

    // Proactively remove any existing listeners to prevent duplicates and MaxListenersExceededWarning
    provider.removeWaaPEventListener('accountsChanged', onAccountsChanged)
    provider.removeWaaPEventListener('chainChanged', onChainChanged)

    // Add listeners to the WaaPEthersProvider using WaaP-specific methods
    provider.addWaaPEventListener('accountsChanged', onAccountsChanged)
    provider.addWaaPEventListener('chainChanged', onChainChanged)

    return () => {
      provider.removeWaaPEventListener('accountsChanged', onAccountsChanged)
      provider.removeWaaPEventListener('chainChanged', onChainChanged)
    }
  }, [provider])


  const disconnect = async () => {
    setError(null)
    
    try {
      await provider?.logout()
      notify('success', 'Wallet disconnected')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to disconnect wallet'
      setError(errorMessage)
      console.log('Logout failed:', error)
    }

    // Reset state regardless of logout success/failure
    setAddress(null)
    setChainId(null)
    setProvider(null)
    setSigner(null)
    setIsConnected(false)
  }

  const value: WaaPContextType = {
    isConnected,
    address,
    chainId,
    provider,
    signer,
    isLoading,
    isConnecting,
    error,
    connect,
    disconnect,
  }

  return (
    <WaaPContext.Provider value={value}>
      {children}
    </WaaPContext.Provider>
  )
}

// Custom hook to use the context
export function useWaaP(): WaaPContextType {
  const context = useContext(WaaPContext)
  if (context === undefined) {
    throw new Error('useWaaP must be used within a WaaPProvider')
  }
  return context
}


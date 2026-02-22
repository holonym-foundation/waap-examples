'use client'

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { useToast } from '@/hooks/useToast'
import { CredentialType, WaaPEthereumProviderInterface, initWaaP } from '@human.tech/waap-sdk'
import { WaaPConfig } from '@/waap.config'

declare global {
  interface Window {
    waap?: WaaPEthereumProviderInterface
  }
}

// Define the context type
interface WaaPContextType {
  // states
  isInitialized: boolean
  isConnected: boolean
  address?: string
  chainId?: number
  isConnecting: boolean
  isDisconnecting: boolean
  loginMethod?: string
    
  // Additional methods
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

// Create the context
const WaaPContext = createContext<WaaPContextType | undefined>(undefined)

// Provider component
interface WaaPProviderProps {
  children: ReactNode
}

export function WaaPProvider({ children }: WaaPProviderProps) {
  const [isInitialized, setIsInitialized] = useState(false)
  const [isConnected, setConnected] = useState(false)
  const [address, setAddress] = useState<string | undefined>()
  const [chainId, setChainId] = useState<number | undefined>()
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [loginMethod, setLoginMethod] = useState<string | undefined>()
  const notify = useToast()

  // Initialize WaaP
  useEffect(() => {
    const initializeWaaP = async () => {
      try {
        // Check if window.waap is already available (extension installed)
        if (typeof window !== 'undefined' && window.waap) {
          setIsInitialized(true)
          
          // Check if already connected
          try {
            const accounts = await window.waap.request({
              method: 'eth_requestAccounts'
            }) as string[]
            const currentChainId = await window.waap.request({
              method: 'eth_chainId'
            }) as string

            // Check for valid accounts (not empty array and not array with empty strings)
            const hasValidAccounts = accounts[0] && accounts[0] !== ''
            
            if (hasValidAccounts) {
              // Wallet is already connected
              setAddress(accounts[0])
              setConnected(true)
              setChainId(Number(currentChainId))
              setLoginMethod(window.waap.getLoginMethod() as string)
            } else {
              // Wallet is not connected
              setAddress(undefined)
              setConnected(false)
              setChainId(undefined)
            }
          } catch (error) {
            console.warn('Failed to check existing connection:', error)
            // If we can't check accounts, assume not connected
            setAddress(undefined)
            setConnected(false)
            setChainId(undefined)
          }
        } else {
          // window.waap is undefined, initialize with initWaaP
          
          // Add timeout to prevent hanging
          const initTimeout = setTimeout(() => {
            console.warn('WaaP initialization timed out')
            setIsInitialized(true)
            notify('warn', 'WaaP initialization timed out. Some features may be limited.')
          }, 15000) // 15 second timeout
          
          try {
            const waap = initWaaP(WaaPConfig)
            
            // Clear timeout if successful
            clearTimeout(initTimeout)
            
            // Set the initialized state
            setIsInitialized(true)
          } catch (initError) {
            // Clear timeout on error
            clearTimeout(initTimeout)
            
            console.warn('WaaP initialization failed, continuing without wallet:', initError)
            // Still set initialized to true so the app can work without wallet
            setIsInitialized(true)
            notify('warn', 'WaaP service unavailable. Some features may be limited.')
          }
        }
      } catch (error) {
        console.error('Failed to initialize WaaP:', error)
        // Set initialized to true anyway so the app doesn't hang
        setIsInitialized(true)
        notify('warn', 'WaaP initialization failed. Some features may be limited.')
      }
    }

    initializeWaaP()
  }, [notify])

  // Set up event listeners
  useEffect(() => {
    if (typeof window !== 'undefined' && window.waap) {
      const handleAccountsChanged = (accounts: unknown) => {
        const accountList = accounts as string[]
        // Check for valid accounts (not empty array and not array with empty strings)
        const hasValidAccounts = accountList && Array.isArray(accountList) && accountList.length > 0 && accountList[0] && accountList[0] !== ''
        
        if (hasValidAccounts) {
          setAddress(accountList[0])
          setConnected(true)
          setLoginMethod(window.waap!.getLoginMethod() as string)
        } else {
          setAddress(undefined)
          setConnected(false)
        }
      }

      const handleChainChanged = (chainId: unknown) => {
        setChainId(Number(chainId as string))
      }

      const handleDisconnect = () => {
        setAddress(undefined)
        setConnected(false)
        setChainId(undefined)
      }

      window.waap.on('accountsChanged', handleAccountsChanged)
      window.waap.on('chainChanged', handleChainChanged)
      window.waap.on('disconnect', handleDisconnect)

      return () => {
        window.waap?.removeListener('accountsChanged', handleAccountsChanged)
        window.waap?.removeListener('chainChanged', handleChainChanged)
        window.waap?.removeListener('disconnect', handleDisconnect)
      }
    }
  }, [])

  const connect = useCallback(async () => {
    if (!isInitialized) {
      notify('error', 'WaaP is not initialized. Please wait for initialization to complete.')
      return
    }

    if (typeof window === 'undefined' || !window.waap) {
      notify('error', 'WaaP not available. Please install the WaaP extension or check your internet connection.')
      return
    }

    setIsConnecting(true)
    try {
      const method = await window.waap.login()
      setLoginMethod(method as string)
      // context states will be updated via the event listeners
    } catch (error) {
      console.error('Connection failed:', error)
      if (error instanceof Error && error.message.includes('timeout')) {
        notify('error', 'Connection timed out. Please check your internet connection and try again.')
      } else {
        notify('error', 'Failed to connect wallet. Please try again.')
      }
    } finally {
      setIsConnecting(false)
    }
  }, [isInitialized, notify])

  const disconnect = useCallback(async () => {
    if (!isInitialized) {
      return
    }

    if (typeof window === 'undefined' || !window.waap) {
      return
    }

    setIsDisconnecting(true)
    try {
      await window.waap.logout()
      // context states will be updated via the event listeners
    } catch (error) {
      console.error('Disconnection failed:', error)
      notify('error', 'Failed to disconnect wallet')
      // Force disconnect on error
      setAddress(undefined)
      setConnected(false)
      setChainId(undefined)
      setLoginMethod(undefined)
    } finally {
      setIsDisconnecting(false)
    }
  }, [isInitialized, notify])

  // Legacy methods for backward compatibility
  const switchChain = useCallback(async (targetChainId: number) => {
    if (!isInitialized) {
      notify('error', 'WaaP is not initialized')
      return
    }

    if (typeof window === 'undefined' || !window.waap) {
      notify('error', 'WaaP not available')
      return
    }

    try {
      await window.waap.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${targetChainId.toString(16)}` }]
      })
    } catch (error) {
      console.error('Chain switch failed:', error)
      notify('error', 'Failed to switch chain')
    }
  }, [isInitialized, notify])

  const sendTransaction = useCallback(async (transaction: {
    to: string
    value: string
    data?: string
  }) => {
    if (!isInitialized) {
      notify('error', 'WaaP is not initialized')
      return
    }

    if (typeof window === 'undefined' || !window.waap) {
      notify('error', 'WaaP not available')
      return
    }

    try {
      const hash = await window.waap.request({
        method: 'eth_sendTransaction',
        params: [transaction]
      })
      return hash
    } catch (error) {
      console.error('Transaction failed:', error)
      notify('error', 'Transaction failed')
      throw error
    }
  }, [isInitialized, notify])

  const signMessage = useCallback(async (message: string) => {
    if (!isInitialized) {
      notify('error', 'WaaP is not initialized')
      return
    }

    if (typeof window === 'undefined' || !window.waap) {
      notify('error', 'WaaP not available')
      return
    }

    try {
      const signature = await window.waap.request({
        method: 'personal_sign',
        params: [message, address]
      })
      return signature
    } catch (error) {
      console.error('Message signing failed:', error)
      notify('error', 'Failed to sign message')
      throw error
    }
  }, [isInitialized, address, notify])

  const context: WaaPContextType = {
    // Additional state
    isInitialized,
    isConnected,
    address,
    chainId,
    isConnecting,
    isDisconnecting,
    loginMethod,
    
    // Additional methods
    connect,
    disconnect,

  }

  return (
    <WaaPContext.Provider value={context}>
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

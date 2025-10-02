'use client'
import RootStyle from '@/components/RootStyle'
import { useToast } from '@/hooks/useToast'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { motion } from 'framer-motion'
import { useIsMounted } from '@/hooks/useIsMounted'
import { truncateAddress } from '@/utils'
import { useEffect, useRef } from 'react'
import MotionButton from '@/components/MotionButton'

import SignMessage from '@/components/methods/SignMessage'
import SendTransaction from '@/components/methods/SendTransaction'
import RequestEmail from '@/components/methods/RequestEmail'
import { SwitchChain } from '@/components/methods/SwitchChain'

export default function HomePage() {
  const notify = useToast()
  const { copyToClipboard } = useCopyToClipboard()
  const isMounted = useIsMounted()

  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending, error, reset } = useConnect()
  const { disconnect } = useDisconnect()
  
  const prevConnectedRef = useRef(isConnected)

  // Watch for connection success
  useEffect(() => {
    if (isConnected && !prevConnectedRef.current) {
      notify('success', 'Wallet connected successfully!')
    }
    prevConnectedRef.current = isConnected
  }, [isConnected, notify])

  // Watch for connection errors
  useEffect(() => {
    if (error) {      
      notify('error', error.message)
    }
  }, [error, notify])

  const handleLogin = async () => {    
    // Reset any previous errors
    if (error) {
      console.log('Resetting previous error')
      reset()
    }
    
    try {
      const WaaPConnector = connectors.find(c => c.id === 'waap')
      console.log('WaaP connector found:', !!WaaPConnector)
      
      if (WaaPConnector) {
        console.log('Attempting to connect...')
        connect({ connector: WaaPConnector })
      } else {
        console.log('No WaaP connector found')
        notify('error', 'No WaaP connector found')
      }
    } catch (error) {
      console.log('Login error in try/catch:', error)
      notify('error', 'Failed to connect wallet')
    }
  }

  const handleLogout = async () => {
    try {
      disconnect()
      notify('success', 'Wallet disconnected')
    } catch (error) {
      console.log('Logout error:', error)
    }
  }


  return (
    <RootStyle>
      <div className='flex flex-col h-full p-6 space-y-6 overflow-auto scrollbar-hide'>
        {/* Header Section */}
        <motion.div
          className='text-center space-y-4'
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}>
          <h1 className='text-black font-pp-hatton text-[22px] font-semibold'>
            WaaP Recipes 🥖
          </h1>
          <p className='text-gray-600 text-[16px] leading-[24px] max-w-md mx-auto'>
            Demo of various WaaP recipes
          </p>
        </motion.div>

        {/* Connection Status */}
        <motion.div
          className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}>
          <h2 className='text-[18px] font-semibold mb-4'>Wallet Status</h2>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <span className='text-gray-600'>Status:</span>
              <span
                className={`px-3 py-1 rounded-full text-sm font-medium ${
                  isMounted && isConnected
                    ? 'bg-green-100 text-green-800'
                    : 'bg-gray-100 text-gray-800'
                }`}>
                {isMounted && isConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            {isMounted && isConnected ? (
              <>
                <div className='flex items-center justify-between'>
                  <span className='text-gray-600'>Address:</span>
                  <button
                    onClick={() => copyToClipboard(address || '', 'Address')}
                    className='text-blue-600 hover:text-blue-800 font-mono text-sm cursor-pointer'>
                    {address ? truncateAddress(address) : 'No address'}
                  </button>
                </div>

                <div className='flex items-center justify-between'>
                  <span className='text-gray-600'>Chain ID:</span>
                  <span className='font-mono text-sm'>{chainId}</span>
                </div>

                <div className='flex items-center justify-between'>
                  <span className='text-gray-600'>Wallet:</span>
                  <span className='text-sm'>WaaP</span>
                </div>

                {/* Disconnect */}
                <MotionButton
                  onClick={handleLogout}
                  variant="danger">
                  Disconnect Wallet
                </MotionButton>
              </>
            ) : (
              <MotionButton
                onClick={handleLogin}
                variant="secondary"
                size="lg"
                className="h-[44px] px-[20px] py-[10px] rounded-[8px]"
                style={{ backgroundColor: '#000000' }}>
                Connect WaaP
              </MotionButton>
            )}
          </div>
        </motion.div>

        {/* Wallet Actions */}
        <motion.div
          className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}>
          <h2 className='text-[18px] font-semibold mb-4'>Recipes</h2>

            <ul className="space-y-3">
              <li>
                <a 
                  href="/stablecoins" 
                  className="inline-flex items-center px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 hover:text-blue-800 rounded-lg border border-blue-200 hover:border-blue-300 transition-all duration-200 font-medium cursor-pointer">
                  💰 Stablecoins
                </a>
              </li>
              <li>
                <a 
                  href="/swap" 
                  className="inline-flex items-center px-4 py-2 bg-green-50 hover:bg-green-100 text-green-700 hover:text-green-800 rounded-lg border border-green-200 hover:border-green-300 transition-all duration-200 font-medium cursor-pointer">
                  🔄 Swapping tokens
                </a>
              </li>
              <li>
                <a 
                  href="/yield" 
                  className="inline-flex items-center px-4 py-2 bg-purple-50 hover:bg-purple-100 text-purple-700 hover:text-purple-800 rounded-lg border border-purple-200 hover:border-purple-300 transition-all duration-200 font-medium cursor-pointer">
                  🌾 Yield farming
                </a>
              </li>
            </ul>
        </motion.div>
      </div>
    </RootStyle>
  )
}
'use client'
import RootStyle from '@/components/RootStyle'
import { useToast } from '@/hooks/useToast'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useWaaP } from '@/waap.context'
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

  const { 
    address, 
    isConnected, 
    chainId,
    connect, 
    disconnect, 
    isConnecting,
    isInitialized,
    loginMethod
  } = useWaaP()
  
  const prevConnectedRef = useRef(isConnected)

  // Watch for connection success
  useEffect(() => {
    if (isConnected && !prevConnectedRef.current) {
      notify('success', 'Wallet connected successfully!')
    }
    prevConnectedRef.current = isConnected
  }, [isConnected, notify])

  const handleLogin = async () => {    
    try {
      console.log('Attempting to connect...')
      await connect()
      // await login()
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
          {/* <div className='flex justify-center'>
            <Image
              src='/assets/svg/human.tech.logo.svg'
              alt='Human.tech logo'
              width={120}
              height={40}
              className='mb-4'
            />
          </div> */}
          <h1 className='text-black font-pp-hatton text-[22px] font-semibold'>
            WaaP Example
          </h1>
          <p className='text-gray-600 text-[16px] leading-[24px] max-w-md mx-auto'>
            Plain (window.waap) + Next.js
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
                  !isMounted || !isInitialized
                    ? 'bg-yellow-100 text-yellow-800'
                    : isConnected
                    ? 'bg-green-100 text-green-800'
                    : 'bg-gray-100 text-gray-800'
                }`}>
                {!isMounted || !isInitialized 
                  ? 'Loading...' 
                  : isConnected 
                  ? 'Connected' 
                  : 'Disconnected'}
              </span>
            </div>

            {isMounted && isConnected && (
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
                  <span className='text-sm'>{loginMethod}</span>
                </div>

                {/* Disconnect */}
                <MotionButton
                  onClick={handleLogout}
                  variant="danger">
                  Disconnect Wallet
                </MotionButton>
              </>
            )}
          </div>
        </motion.div>

        {/* Wallet Actions */}
        <motion.div
          className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}>
          <h2 className='text-[18px] font-semibold mb-4'>Wallet Actions</h2>

          {!isMounted || !isInitialized ? (
            <MotionButton
              onClick={() => {}}
              variant="secondary"
              size="lg"
              className="h-[44px] px-[20px] py-[10px] rounded-[8px]"
              style={{ backgroundColor: '#6B7280' }}
              isLoading={true}
              loadingText="Loading WaaP...">
              Loading WaaP
            </MotionButton>
          ) : !isConnected ? (
            <MotionButton
              onClick={handleLogin}
              variant="secondary"
              size="lg"
              className="h-[44px] px-[20px] py-[10px] rounded-[8px]"
              style={{ backgroundColor: '#000000' }}
              isLoading={isConnecting}
              loadingText="Connecting...">
              Connect WaaP
            </MotionButton>
          ) : (
            <div className='space-y-4'>
              {/* Chain Switching */}
              <SwitchChain />

              {/* Sign Message */}
              <SignMessage />

              {/* Send Transaction */}
              <SendTransaction />

              {/* Request Email */}
              <RequestEmail />

            </div>
          )}
        </motion.div>
      </div>
    </RootStyle>
  )
}
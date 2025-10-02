'use client'
import RootStyle from '@/components/RootStyle'
import { useToast } from '@/hooks/useToast'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useAccount, useConnect, useDisconnect, useSwitchChain, useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi'
import { motion } from 'framer-motion'
import { useIsMounted } from '@/hooks/useIsMounted'
import { truncateAddress } from '@/utils'
import { useEffect, useRef, useState } from 'react'
import MotionButton from '@/components/MotionButton'
import { parseUnits, formatUnits } from 'viem'
import { mainnet, sepolia, base, baseSepolia, optimism } from 'wagmi/chains'
import { QRCodeSVG } from 'qrcode.react'
import Link from 'next/link'

export default function StablecoinsPage() {
  const notify = useToast()
  const { copyToClipboard } = useCopyToClipboard()
  const isMounted = useIsMounted()

  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending, error, reset } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const currentChainId = useChainId()
  
  const prevConnectedRef = useRef(isConnected)

  // State for USDC operations
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [showQR, setShowQR] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMemo, setPaymentMemo] = useState('')

  // USDC contract addresses for different chains
  const getUSDCAddress = (chainId: number) => {
    const addresses: Record<number, string> = {
      [sepolia.id]: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Ethereum Sepolia
      [baseSepolia.id]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
    }
    return addresses[chainId] || addresses[sepolia.id]
  }

  const getChainName = (chainId: number) => {
    const names: Record<number, string> = {
      [sepolia.id]: 'Ethereum Sepolia',
      [baseSepolia.id]: 'Base Sepolia'
    }
    return names[chainId] || 'Unknown'
  }

  // USDC ABI
  const usdcAbi = [
    {
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }]
    },
    {
      name: 'transfer',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' }
      ],
      outputs: [{ name: '', type: 'bool' }]
    }
  ] as const

  // Read USDC balance
  const { data: balance, isLoading: balanceLoading, error: balanceError } = useReadContract({
    address: getUSDCAddress(currentChainId) as `0x${string}`,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && isConnected
    }
  })

  // Write contract for sending USDC
  const { writeContract, data: hash, isPending: isWritePending } = useWriteContract()
  
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  })

  // Set default chain to Base Sepolia on load
  useEffect(() => {
    if (isMounted && isConnected && currentChainId !== baseSepolia.id && switchChain) {
      try {
        switchChain({ chainId: baseSepolia.id })
      } catch (error) {
        console.error('Failed to set default chain to Base Sepolia:', error)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted, isConnected])

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

  // Send USDC function
  const sendUSDC = async () => {
    if (!recipient || !amount) {
      notify('error', 'Please enter recipient address and amount')
      return
    }
    
    try {
      writeContract({
        address: getUSDCAddress(currentChainId) as `0x${string}`,
        abi: usdcAbi,
        functionName: 'transfer',
        args: [recipient as `0x${string}`, parseUnits(amount, 6)], // USDC has 6 decimals
      })
    } catch (error) {
      console.error('Error sending USDC:', error)
      notify('error', 'Failed to send USDC')
    }
  }

  // Generate payment request
  const generatePaymentRequest = () => {
    if (!address) return ''
    
    const paymentRequest = {
      address: address,
      amount: paymentAmount || '100',
      token: 'USDC',
      memo: paymentMemo || 'Payment for services',
      timestamp: Date.now()
    }
    
    return `https://your-app.com/pay?data=${encodeURIComponent(JSON.stringify(paymentRequest))}`
  }

  // Open on-ramp service
  const openOnRamp = (provider: string) => {
    const onRampUrls = {
      'banxa': 'https://banxa.com/',
      'coinbase': 'https://commerce.coinbase.com/',
      'moonpay': 'https://www.moonpay.com/'
    }
    
    window.open(onRampUrls[provider as keyof typeof onRampUrls], '_blank')
  }

  // Format balance for display
  const balanceInUSDC = balance ? formatUnits(balance, 6) : '0'



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
            💰 Stablecoins
          </h1>
          <p className='text-gray-600 text-[12px] leading-[24px] max-w-md mx-auto'>
            Send, receive, and buy USDC stablecoin
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
                Connect with WaaP
              </MotionButton>
            )}
          </div>
        </motion.div>

        {/* USDC Balance */}
        {isMounted && isConnected && (
          <motion.div
            className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}>
            <h2 className='text-[18px] font-semibold mb-4'>USDC Balance</h2>
            <div className='space-y-3'>
              <div className='flex items-center justify-between'>
                <span className='text-gray-600'>Current Chain:</span>
                <span className='font-medium'>{getChainName(currentChainId)}</span>
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-gray-600'>USDC Contract:</span>
                <button
                  onClick={() => copyToClipboard(getUSDCAddress(currentChainId), 'USDC Contract')}
                  className='text-blue-600 hover:text-blue-800 font-mono text-sm cursor-pointer'>
                  {truncateAddress(getUSDCAddress(currentChainId))}
                </button>
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-gray-600'>Your Balance:</span>
                <span className='font-mono text-lg font-semibold'>
                  {balanceLoading ? 'Loading...' : balanceError ? 'Error' : `${balanceInUSDC} USDC`}
                </span>
              </div>
              
              <div className='pt-2 border-t border-gray-100'>
                <a 
                  href="https://faucet.circle.com" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-sm text-blue-600 hover:text-blue-800 hover:underline">
                  🚰 Get testnet USDC from Circle Faucet
                </a>
              </div>
            </div>
          </motion.div>
        )}

        {/* Chain Selection */}
        {isMounted && isConnected && (
          <motion.div
            className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}>
            <h2 className='text-[18px] font-semibold mb-4'>Select Chain</h2>
            <div className='grid grid-cols-2 gap-3'>
              <MotionButton
                onClick={async () => {
                  if (!switchChain) {
                    notify('error', 'Switch chain function not available')
                    return
                  }
                  try {
                    await switchChain({ chainId: sepolia.id })
                    notify('success', 'Switched to ETH Sepolia')
                  } catch (error) {
                    notify('error', `Failed to switch chain: ${error instanceof Error ? error.message : 'Unknown error'}`)
                  }
                }}
                variant={currentChainId === sepolia.id ? "primary" : "secondary"}
                className="text-sm">
                ETH Sepolia
              </MotionButton>
              <MotionButton
                onClick={async () => {
                  if (!switchChain) {
                    notify('error', 'Switch chain function not available')
                    return
                  }
                  try {
                    await switchChain({ chainId: baseSepolia.id })
                    notify('success', 'Switched to Base Sepolia')
                  } catch (error) {
                    notify('error', `Failed to switch chain: ${error instanceof Error ? error.message : 'Unknown error'}`)
                  }
                }}
                variant={currentChainId === baseSepolia.id ? "primary" : "secondary"}
                className="text-sm">
                Base Sepolia
              </MotionButton>
            </div>
          </motion.div>
        )}

        {/* Receive USDC */}
        {isMounted && isConnected && (
          <motion.div
            className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}>
            <h2 className='text-[18px] font-semibold mb-4'>Receive USDC</h2>
            <div className='space-y-4'>
              <div className='flex items-center justify-between'>
                <span className='text-gray-600'>Your Address:</span>
                <button
                  onClick={() => copyToClipboard(address || '', 'Address')}
                  className='text-blue-600 hover:text-blue-800 font-mono text-sm cursor-pointer'>
                  {address ? truncateAddress(address) : 'No address'}
                </button>
              </div>
              
              <div className='flex gap-3'>
                <MotionButton
                  onClick={() => setShowQR(!showQR)}
                  variant="secondary"
                  className="flex-1">
                  {showQR ? 'Hide' : 'Show'} QR Code
                </MotionButton>
              </div>

              {showQR && address && (
                <div className='flex flex-col items-center space-y-3 p-4 bg-gray-50 rounded-lg'>
                  <h3 className='text-sm font-medium text-gray-700'>Scan to send USDC</h3>
                  <QRCodeSVG value={address} size={200} />
                  <p className='text-xs text-gray-500 font-mono break-all'>{address}</p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Send USDC */}
        {isMounted && isConnected && (
          <motion.div
            className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}>
            <h2 className='text-[18px] font-semibold mb-4'>Send USDC</h2>
            <div className='space-y-4'>
              <div>
                <label className='block text-sm font-medium text-gray-700 mb-2'>
                  Recipient Address
                </label>
                <input
                  type="text"
                  placeholder="0x..."
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                />
              </div>
              
              <div>
                <label className='block text-sm font-medium text-gray-700 mb-2'>
                  Amount (USDC)
                </label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                />
              </div>

              <MotionButton
                onClick={sendUSDC}
                disabled={isWritePending || isConfirming || !recipient || !amount}
                variant="primary"
                className="w-full">
                {isWritePending ? 'Confirming...' : isConfirming ? 'Sending...' : 'Send USDC'}
              </MotionButton>

              {hash && (
                <div className='p-3 bg-blue-50 rounded-lg'>
                  <p className='text-sm text-blue-700'>
                    Transaction: <span className='font-mono'>{truncateAddress(hash)}</span>
                  </p>
                </div>
              )}
              
              {isSuccess && (
                <div className='p-3 bg-green-50 rounded-lg'>
                  <p className='text-sm text-green-700'>Transaction successful!</p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* On-Ramp Integration */}
        {isMounted && isConnected && (
          <motion.div
            className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.6 }}>
            <h2 className='text-[18px] font-semibold mb-4'>Buy USDC with Fiat</h2>
            <div className='grid grid-cols-1 gap-3'>
              <MotionButton
                onClick={() => openOnRamp('banxa')}
                variant="secondary"
                className="justify-start">
                Buy with Banxa
              </MotionButton>
              <MotionButton
                onClick={() => openOnRamp('coinbase')}
                variant="secondary"
                className="justify-start">
                Buy with Coinbase
              </MotionButton>
              <MotionButton
                onClick={() => openOnRamp('moonpay')}
                variant="secondary"
                className="justify-start">
                Buy with MoonPay
              </MotionButton>
            </div>
          </motion.div>
        )}

        {/* Payment Request Generation */}
        {isMounted && isConnected && (
          <motion.div
            className='bg-white rounded-2xl p-6 shadow-sm border border-gray-100'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7 }}>
            <h2 className='text-[18px] font-semibold mb-4'>Generate Payment Request</h2>
            <div className='space-y-4'>
              <div>
                <label className='block text-sm font-medium text-gray-700 mb-2'>
                  Amount (USDC)
                </label>
                <input
                  type="number"
                  placeholder="100"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                />
              </div>
              
              <div>
                <label className='block text-sm font-medium text-gray-700 mb-2'>
                  Memo (Optional)
                </label>
                <input
                  type="text"
                  placeholder="Payment for services"
                  value={paymentMemo}
                  onChange={(e) => setPaymentMemo(e.target.value)}
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                />
              </div>

              <div className='p-3 bg-gray-50 rounded-lg'>
                <p className='text-sm text-gray-700 mb-2'>Payment Request URL:</p>
                <p className='text-xs font-mono break-all text-blue-600'>
                  {generatePaymentRequest()}
                </p>
                <MotionButton
                  onClick={() => copyToClipboard(generatePaymentRequest(), 'Payment Request')}
                  variant="secondary"
                  size="sm"
                  className="mt-2">
                  Copy Link
                </MotionButton>
              </div>
            </div>
          </motion.div>
        )}

        {/* Back to Recipes */}
        <Link 
          href="/" 
          className="inline-flex items-center px-4 py-2 bg-gray-50 hover:bg-gray-100 text-gray-700 hover:text-gray-800 rounded-lg border border-gray-200 hover:border-gray-300 transition-all duration-200 font-medium cursor-pointer">
          ← Back to All Recipes
        </Link>

      </div>
    </RootStyle>
  )
}
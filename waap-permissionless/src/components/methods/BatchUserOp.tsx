'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { parseEther } from 'viem'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

interface BatchUserOpProps {
  smartAccountClient: any
  isConnected: boolean
  onSuccess?: () => void
}

export default function BatchUserOp({ smartAccountClient, isConnected, onSuccess }: BatchUserOpProps) {
  const [output, setOutput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  
  const notify = useToast()

  const handleBatchUserOp = async () => {
    if (!isConnected || !smartAccountClient) {
      notify('error', 'Smart Account not ready')
      return
    }

    setIsLoading(true)
    setOutput('')

    try {
      console.log('Sending Batch UserOp...')
      
      // Batch execute: 2 dummy transactions
      const txHash = await smartAccountClient.sendTransaction({
        calls: [
          {
            to: '0x0000000000000000000000000000000000000000',
            value: parseEther('0'),
            data: '0x'
          },
          {
            to: '0x0000000000000000000000000000000000000000',
            value: parseEther('0'),
            data: '0x'
          }
        ]
      })

      console.log('Batch UserOp sent! Hash:', txHash)
      setOutput(txHash)
      notify('success', 'Batch UserOp submitted successfully!')
      if (onSuccess) onSuccess()

    } catch (error: any) {
      console.error('Batch UserOp failed:', error)
      notify('error', `Batch UserOp failed: ${error.message || error}`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className='mt-6 border-t pt-6 border-gray-100'>
      <h3 className='text-[16px] font-medium mb-2'>Batch UserOp (Multi-Call)</h3>
      <p className='text-sm text-gray-600 mb-3'>
        Sends multiple transactions in a single atomic UserOperation.
      </p>

      <div className='bg-gray-50 p-3 rounded-lg mb-3'>
        <p className='text-xs text-gray-500'>
          1. Target: 0x000...000 (0 ETH)<br/>
          2. Target: 0x000...000 (0 ETH)
        </p>
      </div>

      <MotionButton
        onClick={handleBatchUserOp}
        disabled={!isConnected || !smartAccountClient || isLoading}
        isLoading={isLoading}
        loadingText="Sending Batch..."
        variant="primary"
        className="w-full">
        Send Sponsored Batch
      </MotionButton>

      <Output 
        label="Transaction Hash" 
        value={output}
        link={output ? `https://sepolia.etherscan.io/tx/${output}` : undefined}
      />
    </div>
  )
}

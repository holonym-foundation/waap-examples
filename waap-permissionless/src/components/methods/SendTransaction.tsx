'use client'

import { useToast } from '@/hooks/useToast'
import { useState, useEffect } from 'react'
import { useAccount, useSendTransaction } from 'wagmi'
import { parseEther } from 'viem'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function SendTransaction() {
  const [output, setOutput] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('0x5c5242DC44792AF10f247fF426478c845A7320D2') // Dummy address

  const notify = useToast()
  const { isConnected, connector, chainId } = useAccount()
  const { sendTransaction, isPending, data, error, reset } = useSendTransaction()

  // Reset error state when chain changes
  useEffect(() => {
    reset() // Clear any previous error states
  }, [chainId, reset])

  useEffect(() => {
    if (data) {
      setOutput(data)
      notify('success', '[sendTransaction] successful!')
    }
  }, [data, notify])

  useEffect(() => {
    if (error) {
      console.log('[sendTransaction] error:', error)
      notify('error', '[sendTransaction] failed: ' + error)
      
      // Reset the error state after showing the notification
      setTimeout(() => {
        reset()
      }, 100) // Small delay to ensure toast is shown
    }
  }, [error, notify, reset])

  const handleSendTransaction = async () => {
    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    if (!recipientAddress.trim()) {
      notify('error', 'Please enter a recipient address')
      return
    }

    try {
      console.log('Attempting to send transaction...')
      console.log('Recipient:', recipientAddress)
      console.log('Amount: 0.000001 ETH')
      
      // Add some debugging for the connector
      console.log('Connector:', connector)
      console.log('Connector ID:', connector?.id)
      console.log('Connector methods:', Object.getOwnPropertyNames(connector || {}))
      console.log('getChainId method exists:', typeof connector?.getChainId)
      
      await sendTransaction({
        to: recipientAddress as `0x${string}`,
        value: parseEther('0.000001'), // 0.000001 ETH
      })
    } catch (error) {
      console.log('[sendTransaction] error:', error)
      console.log('Error details:', error)
      notify('error', '[sendTransaction] failed: ' + error)
    }
  }


  return (
    <div>
      <h3 className='text-[16px] font-medium mb-2'>Send Transaction</h3>
      <div className='space-y-3'>
        <div>
          <label className='block text-sm font-medium text-gray-700 mb-1'>
            Recipient Address
          </label>
          <input
            type="text"
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            placeholder='0x...'
            className='w-full p-3 border border-gray-200 rounded-lg text-sm font-mono'
          />
        </div>
        
        <div className='bg-gray-50 p-3 rounded-lg'>
          <p className='text-sm text-gray-600'>
            <span className='font-medium'>Amount:</span> 0.000001 ETH
          </p>
          <p className='text-xs text-amber-600 mt-1'>
            ⚠️ Note: You need at least 0.000001 ETH in your wallet to send this transaction
          </p>
        </div>

        <div className="flex gap-2">
          <MotionButton
            onClick={handleSendTransaction}
            disabled={!recipientAddress.trim() || !isConnected}
            isLoading={isPending}
            loadingText="Sending..."
            variant="success"
            className="flex-1">
            Send Transaction
          </MotionButton>
          
          {error && (
            <MotionButton
              onClick={() => reset()}
              variant="secondary"
              size="sm">
              Clear Error
            </MotionButton>
          )}
        </div>
      </div>

      <Output label="Transaction Hash" value={output} />
    </div>
  )
}

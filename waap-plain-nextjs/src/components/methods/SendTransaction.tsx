'use client'

import { useToast } from '@/hooks/useToast'
import { useState, useEffect } from 'react'
import { useWaaP } from '@/waap.context'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function SendTransaction() {
  const [output, setOutput] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('0x5c5242DC44792AF10f247fF426478c845A7320D2') // Dummy address
  const [isPending, setIsPending] = useState(false)

  const notify = useToast()
  const { isConnected, isInitialized, address, chainId } = useWaaP()

  const handleSendTransaction = async () => {
    if (!isInitialized) {
      notify('error', 'WaaP is not initialized')
      return
    }

    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    if (!recipientAddress.trim()) {
      notify('error', 'Please enter a recipient address')
      return
    }

    setIsPending(true)
    try {
      console.log('Attempting to send transaction...')
      console.log('Recipient:', recipientAddress)
      console.log('Amount: 0.000001 ETH')
      
      const hash = await window.waap?.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: address,
            to: recipientAddress,
            value: '0x38D7EA4C68000', // 0.000001 ETH in hex
          }
        ]
      })
      
      setOutput(String(hash))
      notify('success', '[sendTransaction] successful!')
    } catch (error) {
      console.log('[sendTransaction] error:', error)
      console.log('Error details:', error)
      notify('error', '[sendTransaction] failed: ' + error)
    } finally {
      setIsPending(false)
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

        <MotionButton
          onClick={handleSendTransaction}
          disabled={!recipientAddress.trim() || !isInitialized || !isConnected}
          isLoading={isPending}
          loadingText="Sending..."
          variant="success"
          className="w-full">
          Send Transaction
        </MotionButton>
      </div>

      <Output label="Transaction Hash" value={output} />
    </div>
  )
}

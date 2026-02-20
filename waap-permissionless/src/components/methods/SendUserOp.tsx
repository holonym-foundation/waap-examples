'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { parseEther } from 'viem'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

interface SendUserOpProps {
  smartAccountClient: any
  isConnected: boolean
  onSuccess?: () => void
}

export default function SendUserOp({ smartAccountClient, isConnected, onSuccess }: SendUserOpProps) {
  const [output, setOutput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  
  const notify = useToast()

  const handleSendUserOp = async () => {
    if (!isConnected || !smartAccountClient) {
      notify('error', 'Smart Account not ready')
      return
    }

    setIsLoading(true)
    setOutput('')

    try {
      console.log('Sending UserOp...')
      
      // Send a 0 ETH transaction to self (or dummy) just to test the pipelie
      const txHash = await smartAccountClient.sendTransaction({
        to: '0x0000000000000000000000000000000000000000', 
        value: parseEther('0'),
        data: '0x'
      })

      console.log('UserOp sent! Hash:', txHash)
      setOutput(txHash)
      notify('success', 'UserOp submitted successfully!')
      if (onSuccess) onSuccess()

    } catch (error: any) {
      console.error('UserOp failed:', error)
      notify('error', `UserOp failed: ${error.message || error}`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div>
      <h3 className='text-[16px] font-medium mb-2'>Send UserOp (Zero ETH)</h3>
      <p className='text-sm text-gray-600 mb-3'>
        Sends a sponsored UserOperation to the bundler. No gas fees required from your EOA.
      </p>

      <div className='bg-gray-50 p-3 rounded-lg mb-3'>
        <p className='text-xs text-gray-500'>
          Target: 0x000...000<br/>
          Value: 0 ETH
        </p>
      </div>

      <MotionButton
        onClick={handleSendUserOp}
        disabled={!isConnected || !smartAccountClient || isLoading}
        isLoading={isLoading}
        loadingText="Sending UserOp..."
        variant="primary"
        className="w-full">
        Send Sponsored UserOp
      </MotionButton>

      <Output 
        label="Transaction Hash" 
        value={output} 
        link={output ? `https://sepolia.etherscan.io/tx/${output}` : undefined}
      />
    </div>
  )
}

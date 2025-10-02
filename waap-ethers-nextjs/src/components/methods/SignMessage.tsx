'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { useWaaP } from '@/waap.context'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function SignMessage() {
  const [message, setMessage] = useState('Hello from WaaP!')
  const [output, setOutput] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const notify = useToast()
  const { isConnected, signer } = useWaaP()

  const handleSignMessage = async () => {
    if (!message.trim()) {
      notify('error', 'Please enter a message to sign')
      return
    }

    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    if (!signer) {
      notify('error', 'Wallet signer not available')
      return
    }

    setIsLoading(true)
    try {
      // Use signer directly to sign message
      const signature = await signer.signMessage(message)
      setOutput(signature)
      notify('success', 'Message signed successfully!')
    } catch (error: unknown) {
      console.log('Sign message error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      notify('error', 'Failed to sign message: ' + errorMessage)
    } finally {
      setIsLoading(false)
    }
  }


  return (
    <div>
      <h3 className='text-[16px] font-medium mb-2'>Sign Message</h3>
      <div className='space-y-3'>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Enter message to sign...'
          className='w-full p-3 border border-gray-200 rounded-lg resize-none h-20 text-sm'
        />
        <MotionButton
          onClick={handleSignMessage}
          disabled={!message.trim() || !isConnected}
          isLoading={isLoading}
          loadingText="Signing..."
          variant="primary">
          Sign Message
        </MotionButton>
      </div>

      <Output label="Signature" value={output} />
    </div>
  )
}

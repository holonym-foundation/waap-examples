'use client'

import { useToast } from '@/hooks/useToast'
import { useState, useEffect } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function SignMessage() {
  const [message, setMessage] = useState('Hello from WaaP!')
  const [output, setOutput] = useState('')

  const notify = useToast()
  const { isConnected } = useAccount()
  const { signMessage, isPending, data } = useSignMessage()

  useEffect(() => {
    if (data) {
      setOutput(data)
      notify('success', 'Message signed successfully!')
    }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSignMessage = async () => {
    if (!message.trim()) {
      notify('error', 'Please enter a message to sign')
      return
    }

    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    try {
      await signMessage({ message })
    } catch (error) {
      console.log('Sign message error:', error)
      notify('error', 'Failed to sign message')
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
          isLoading={isPending}
          loadingText="Signing..."
          variant="primary">
          Sign Message
        </MotionButton>
      </div>

      <Output label="Signature" value={output} />
    </div>
  )
}

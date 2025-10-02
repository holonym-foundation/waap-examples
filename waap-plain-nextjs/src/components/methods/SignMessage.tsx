'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { useWaaP } from '@/waap.context'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function SignMessage() {
  const [message, setMessage] = useState('Hello from Human Wallet!')
  const [output, setOutput] = useState('')
  const [isPending, setIsPending] = useState(false)

  const notify = useToast()
  const { isConnected, isInitialized, address } = useWaaP()

  const handleSignMessage = async () => {
    if (!message.trim()) {
      notify('error', 'Please enter a message to sign')
      return
    }

    if (!isInitialized) {
      notify('error', 'WaaP is not initialized')
      return
    }

    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    setIsPending(true)
    try {
      const signature = await window.silk?.request({
        method: 'personal_sign',
        params: [message, address]
      })
      setOutput(String(signature))
      notify('success', 'Message signed successfully!')
    } catch (error) {
      console.log('Sign message error:', error)
      notify('error', 'Failed to sign message')
    } finally {
      setIsPending(false)
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
          disabled={!message.trim() || !isInitialized || !isConnected}
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

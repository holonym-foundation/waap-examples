'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { useWaaP } from '@/waap.context'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function RequestEmail() {
  const [output, setOutput] = useState('')
  const [isPending, setIsPending] = useState(false)

  const notify = useToast()
  const { isConnected, provider } = useWaaP()

  const handleRequestEmail = async () => {
    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    if (!provider) {
      notify('error', 'Wallet provider not available')
      return
    }

    setIsPending(true)
    try {
      const result = await provider.requestEmail()
      setOutput(JSON.stringify(result, null, 2))
      notify('success', '[requestEmail] successful!')
    } catch (error: unknown) {
      console.log('[requestEmail] failed: ', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      notify('error', '[requestEmail] failed: ' + errorMessage)
    } finally {
      setIsPending(false)
    }
  }


  return (
    <div>
      <h3 className='text-[16px] font-medium mb-2'>Request Email</h3>
      <div className='space-y-3'>
        <MotionButton
          onClick={handleRequestEmail}
          disabled={!isConnected}
          isLoading={isPending}
          loadingText="Requesting..."
          variant="primary">
          Request Email
        </MotionButton>
      </div>

      <Output label="Email Response" value={output} />
    </div>
  )
}
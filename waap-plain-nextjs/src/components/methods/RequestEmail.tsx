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
  const { isConnected, isInitialized } = useWaaP()

  const handleRequestEmail = async () => {
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
      // Call requestEmail
      const result = await window.waap?.requestEmail()
      setOutput(JSON.stringify(result, null, 2))
      notify('success', '[requestEmail] successful!')
    } catch (error) {
      console.log('[requestEmail] failed: ', error)
      notify('error', '[requestEmail] failed: ' + error)
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
          disabled={!isInitialized || !isConnected}
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
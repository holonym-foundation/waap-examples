'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { isWaaPConnector } from '@/waap.connector'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

export default function RequestEmail() {
  const [output, setOutput] = useState('')
  const [isPending, setIsPending] = useState(false)

  const notify = useToast()
  const { isConnected, connector } = useAccount()

  const handleRequestEmail = async () => {
    if (!isConnected) {
      notify('error', 'Please connect your wallet first')
      return
    }

    if (!isWaaPConnector(connector)) {
      notify('error', 'WaaP connector not found')
      return
    }

    setIsPending(true)
    try {
      // Call requestEmail
      const result = await connector.requestEmail()
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
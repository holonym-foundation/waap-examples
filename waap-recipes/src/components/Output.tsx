'use client'

import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useState, useEffect } from 'react'

interface OutputProps {
  label: string
  value: string
  className?: string
  autoHide?: boolean
  hideAfter?: number // in milliseconds
}

export default function Output({ 
  label, 
  value, 
  className = '', 
  autoHide = true,
  hideAfter = 8000 
}: OutputProps) {
  const { copyToClipboard } = useCopyToClipboard()
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    if (!value || !autoHide) return

    // Show the output
    setIsVisible(true)

    // Hide after specified time
    const timer = setTimeout(() => {
      setIsVisible(false)
    }, hideAfter)

    return () => clearTimeout(timer)
  }, [value, autoHide, hideAfter])

  if (!value || !isVisible) return null

  return (
    <div className={`mt-3 p-3 bg-gray-50 rounded-lg ${className}`}>
      <p className='text-sm font-medium text-gray-700 mb-1'>
        {label}:
      </p>
      <button
        onClick={() => copyToClipboard(value, label)}
        className='text-xs font-mono text-gray-600 hover:text-gray-800 break-all cursor-pointer'>
        {value}
      </button>
    </div>
  )
}

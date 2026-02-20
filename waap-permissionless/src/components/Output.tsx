'use client'

import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useState, useEffect } from 'react'
import { Icon } from '@iconify/react'

interface OutputProps {
  label: string
  value: string
  className?: string
  autoHide?: boolean
  hideAfter?: number // in milliseconds
  link?: string
}

export default function Output({ 
  label, 
  value, 
  className = '', 
  autoHide = true,
  hideAfter = 12000,
  link
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
      <div className='flex justify-between items-center mb-1'>
        <p className='text-sm font-medium text-gray-700'>
          {label}:
        </p>
        
        {link && (
          <a 
            href={link} 
            target="_blank" 
            rel="noopener noreferrer" 
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 transition-colors"
          >
            Explorer <Icon icon="ph:arrow-square-out-bold" />
          </a>
        )}
      </div>
      
      <button
        onClick={() => copyToClipboard(value, label)}
        className='text-xs font-mono text-gray-600 hover:text-gray-800 break-all cursor-pointer text-left w-full hover:bg-gray-100 p-1 -ml-1 rounded transition-colors'>
        {value}
      </button>
    </div>
  )
}

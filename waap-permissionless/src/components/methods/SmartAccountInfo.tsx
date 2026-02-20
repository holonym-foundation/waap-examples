'use client'

import React from 'react'
import { Icon } from '@iconify/react'
import { truncateAddress } from '@/utils'

interface SmartAccountInfoProps {
  smartAccountAddress: string | null
  isDeployed: boolean
  isLoading: boolean
}

export default function SmartAccountInfo({
  smartAccountAddress,
  isDeployed,
  isLoading
}: SmartAccountInfoProps) {
  const explorerUrl = 'https://sepolia.etherscan.io'
  const href = explorerUrl ? `${explorerUrl}/address/${smartAccountAddress}` : '#'

  if (isLoading) {
    return (
      <div className='p-4 bg-gray-50 rounded-lg animate-pulse'>
        <div className='h-4 bg-gray-200 rounded w-1/2 mb-2'></div>
        <div className='h-3 bg-gray-200 rounded w-1/3'></div>
      </div>
    )
  }

  if (!smartAccountAddress) return null

  return (
    <div className='bg-gray-50 rounded-lg p-4 mb-6 border border-gray-100'>
      <div className='flex items-center justify-between mb-2'>
        <h3 className='text-sm font-medium text-gray-700'>ERC-4337</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${isDeployed ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
          {isDeployed ? 'Deployed' : 'Not Deployed'}
        </span>
      </div>
      
      <div className='flex items-center justify-between bg-white p-3 rounded border border-gray-200'>
        <a 
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className='font-mono text-sm text-blue-600 hover:text-blue-800 break-all flex items-center gap-1 transition-colors'
          title='View on Explorer'
        >
          {truncateAddress(smartAccountAddress)}
          <Icon icon='ph:arrow-square-out' width={16} height={16} />
        </a>
      </div>
      
      {!isDeployed && (
        <p className='text-xs text-gray-500 mt-2'>
          This smart account will be deployed automatically with your first transaction.
        </p>
      )}
    </div>
  )
}

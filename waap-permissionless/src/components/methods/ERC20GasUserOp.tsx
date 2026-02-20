'use client'

import { useToast } from '@/hooks/useToast'
import { useState } from 'react'
import { parseEther, parseUnits, encodeFunctionData, erc20Abi } from 'viem'
import Output from '@/components/Output'
import MotionButton from '@/components/MotionButton'

interface ERC20GasUserOpProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  smartAccountClient: any
  isConnected: boolean
  onSuccess?: () => void
}

export default function ERC20GasUserOp({ smartAccountClient, isConnected, onSuccess }: ERC20GasUserOpProps) {
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
      console.log('Sending UserOp with ERC-20 Gas...')
      
      // USDC address on Sepolia
      const usdcAddress = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
      // Pimlico ERC-20 Paymaster
      const pimlicoPaymasterAddress = '0x777777777777AeC03fd955926DbF81597e66834C'
      
      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [pimlicoPaymasterAddress, parseUnits('1', 6)] // Approve 1 USDC
      })

      // Batch the ERC20 approve and the dummy transaction into a single UserOp
      const txHash = await smartAccountClient.sendTransaction({
        calls: [
          {
            to: usdcAddress,
            value: BigInt(0),
            data: approveData
          },
          {
            to: '0x0000000000000000000000000000000000000000', 
            value: parseEther('0'),
            data: '0x'
          }
        ],
        paymasterContext: {
          token: usdcAddress
        }
      })

      console.log('UserOp sent! Hash:', txHash)
      setOutput(txHash)
      notify('success', 'ERC-20 Gas UserOp submitted successfully!')
      if (onSuccess) onSuccess()

    } catch (error: unknown) {
      console.error('ERC-20 Gas UserOp failed:', error)
      const err = error as { message?: string }
      notify('error', `ERC-20 Gas UserOp failed: ${err.message || error}`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div>
      <h3 className='text-[16px] font-medium mb-2'>Pay Gas in USDC (ERC-20)</h3>
      <p className='text-sm text-gray-600 mb-3'>
        Sends a UserOperation and pays for the gas fees using Sepolia USDC via the Pimlico paymaster. 
        <br />
        <br />
        <strong>Note:</strong> You must first fund this Smart Account with Ethereum Sepolia USDC.{' '}
        <a 
          href="https://faucet.circle.com/" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline"
        >
          Get USDC from Circle Faucet here
        </a>.
      </p>

      <div className='bg-gray-50 p-3 rounded-lg mb-3'>
        <p className='text-xs text-gray-500'>
          Target: 0x00...00<br/>
          Value: 0 ETH<br/>
          Gas Token: USDC (0x1c7...238)
        </p>
      </div>

      <MotionButton
        onClick={handleSendUserOp}
        disabled={!isConnected || !smartAccountClient || isLoading}
        isLoading={isLoading}
        loadingText="Sending UserOp..."
        variant="primary"
        className="w-full bg-blue-600 hover:bg-blue-700">
        Send with USDC Gas
      </MotionButton>

      <Output 
        label="Transaction Hash" 
        value={output} 
        link={output ? `https://sepolia.etherscan.io/tx/${output}` : undefined}
      />
    </div>
  )
}

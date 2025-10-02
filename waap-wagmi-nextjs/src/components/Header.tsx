'use client'

import Image from 'next/image'
import Link from 'next/link'
import React, { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useIsMounted } from '@/hooks/useIsMounted'
import { Icon } from '@iconify/react'

type WalletDisplayProps = {
  address?: string
  isConnected: boolean
  walletIcon: string
  networkIcon?: string
  onClick?: () => void
  onDisconnect?: () => void
  walletType: 'human'
}

const WalletDisplay: React.FC<WalletDisplayProps> = ({
  address,
  isConnected,
  walletIcon,
  networkIcon,
  onClick,
  onDisconnect,
  walletType,
}) => {
  const [showDropdown, setShowDropdown] = useState(false)
  const [copied, setCopied] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  const handleClick = () => {
    setShowDropdown(!showDropdown)
  }

  const handleCopyAddress = () => {
    if (address) {
      // Copy the address to clipboard
      navigator.clipboard.writeText(address)

      // Show the "Copied!" tooltip
      setCopied(true)

      // Hide the tooltip after 2 seconds
      setTimeout(() => {
        setCopied(false)
        // Only close dropdown after tooltip is hidden
        setShowDropdown(false)
      }, 2000)
    }
  }

  const handleDisconnect = () => {
    if (onDisconnect) {
      onDisconnect()
    }
    setShowDropdown(false)
  }

  const WaaPUrl = 'https://waap.xyz'
  
  const handleOpenWallet = () => {
    window.open(WaaPUrl, '_blank', 'noopener,noreferrer')
    setShowDropdown(false)
  }

  if (!isConnected) return null

  return (
    <div className='relative' ref={dropdownRef}>
      <div
        className='flex px-[8px] py-[4px] justify-center items-center gap-[12px] rounded-[8px] border border-[#D4D4D4] bg-white cursor-pointer hover:shadow-md transition-shadow duration-200'
        onClick={handleClick}
        data-tooltip-id={`tooltip-${walletType}`}>
        <Image src={walletIcon} alt='Wallet' width={24} height={24} />
        {/* {networkIcon && (
          <Image src={networkIcon} alt='Network' width={20} height={20} />
        )} */}
        <span className='text-sm font-medium'>
          {address
            ? `${address.substring(0, 6)}...${address.substring(
                address.length - 4
              )}`
            : ''}
        </span>
        <Image
          src='/assets/svg/drop-down-logo.svg'
          alt='Dropdown'
          width={24}
          height={24}
        />
      </div>

      {showDropdown && (
        <div className='absolute right-0 mt-2 shadow-lg z-10 min-w-[180px] py-2  rounded-[12px] border border-[#D4D4D4] bg-white '>
          <div
            className='flex items-center gap-2 px-4 py-2 hover:bg-gray-100 cursor-pointer relative transition-colors duration-150 hover:bg-latest-grey-300'
            onClick={handleCopyAddress}>
            <Icon icon='ph:copy' width={20} height={20} />
            <span>{copied ? 'Copied!' : 'Copy Address'}</span>
          </div>

          {isConnected && (
            <div
              className='flex items-center gap-2 px-4 py-2 hover:bg-gray-100 cursor-pointer relative transition-colors duration-150 hover:bg-latest-grey-300'
              onClick={handleOpenWallet}>
              <Icon icon='majesticons:open' width={20} height={20} />
              <span>Open WaaP</span>
            </div>
          )}

          <div
            className='flex items-center gap-2 px-4 py-2 hover:bg-gray-100 cursor-pointer text-red-500 transition-colors duration-150 hover:bg-latest-grey-300'
            onClick={handleDisconnect}>
            <Icon icon='ph:sign-out' width={20} height={20} />
            <span>Disconnect</span>
          </div>
        </div>
      )}
    </div>
  )
}

const Header = () => {
  const { address, isConnected, chainId } = useAccount()
  const { disconnect } = useDisconnect()
  const isMounted = useIsMounted()

  const handleDisconnect = () => {
    disconnect()
  }

  // Prevent hydration mismatch by not rendering wallet state during SSR
  if (!isMounted) {
    return (
      <header className='w-full px-2 sm:px-4 pt-3 bg-gray-100'>
        {/* Mobile Layout */}
        <div className='block md:hidden'>
          <div className='flex justify-between items-center mb-3'>
            <Link
              href='/'
              className='hover:opacity-80 transition-opacity duration-200'>
              <Image
                src='/assets/svg/human.tech.logo.svg'
                alt='human.tech'
                width={100}
                height={25}
              />
            </Link>
          </div>
          <nav className='flex justify-center pb-2'>
          </nav>
        </div>

        {/* Desktop Layout */}
        <div className='hidden md:grid md:grid-cols-3 items-center gap-4'>
          {/* Logo - Left */}
          <div className='flex justify-start'>
            <Link
              href='/'
              className='hover:opacity-80 transition-opacity duration-200'>
              <Image
                src='/assets/svg/human.tech.logo.svg'
                alt='human.tech'
                width={120}
                height={30}
              />
            </Link>
          </div>

          {/* Navigation Links - Center */}
          <nav className='flex justify-center'>
            <div className='flex gap-6 items-center'>
            </div>
          </nav>

          {/* Wallet Display - Right */}
          <div className='flex justify-end'>
          </div>
        </div>
      </header>
    )
  }

  return (
    <header className='w-full px-2 sm:px-4 pt-3 bg-gray-100'>
      {/* Mobile Layout */}
      <div className='block md:hidden'>
        <div className='flex justify-between items-center mb-3'>
          <Link
            href='/'
            className='hover:opacity-80 transition-opacity duration-200'>
            <Image
              src='/assets/svg/human.tech.logo.svg'
              alt='human.tech'
              width={100}
              height={25}
            />
          </Link>
          <WalletDisplay
            address={address}
            isConnected={isConnected}
            walletIcon='/assets/svg/wally-dark.svg'
            networkIcon='/assets/svg/network-logo.svg'
            onDisconnect={handleDisconnect}
            walletType='human'
          />
        </div>
        <nav className='flex justify-center pb-2'>
        </nav>
      </div>

      {/* Desktop Layout */}
      <div className='hidden md:grid md:grid-cols-3 items-center gap-4'>
        {/* Logo - Left */}
        <div className='flex justify-start'>
          <Link
            href='/'
            className='hover:opacity-80 transition-opacity duration-200'>
            <Image
              src='/assets/svg/human.tech.logo.svg'
              alt='human.tech'
              width={120}
              height={30}
            />
          </Link>
        </div>

        {/* Navigation Links - Center */}
        <nav className='flex justify-center'>
          <div className='flex gap-6 items-center'>
          </div>
        </nav>

        {/* Wallet Display - Right */}
        <div className='flex justify-end'>
          <WalletDisplay
            address={address}
            isConnected={isConnected}
            walletIcon='/assets/svg/wally-dark.svg'
            networkIcon='/assets/svg/network-logo.svg'
            onDisconnect={handleDisconnect}
            walletType='human'
          />
        </div>
      </div>
    </header>
  )
}

export default Header

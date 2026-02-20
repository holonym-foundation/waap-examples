'use client'

import { motion } from 'framer-motion'
import { ReactNode } from 'react'

interface MotionButtonProps {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  isLoading?: boolean
  loadingText?: string
  variant?: 'primary' | 'secondary' | 'danger' | 'success'
  size?: 'sm' | 'md' | 'lg'
  className?: string
  style?: React.CSSProperties
}

const variants = {
  primary: {
    backgroundColor: '#2563eb',
    hoverColor: '#1d4ed8'
  },
  secondary: {
    backgroundColor: '#6b7280',
    hoverColor: '#4b5563'
  },
  danger: {
    backgroundColor: '#dc2626',
    hoverColor: '#b91c1c'
  },
  success: {
    backgroundColor: '#16a34a',
    hoverColor: '#15803d'
  }
}

const sizes = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg'
}

export default function MotionButton({
  children,
  onClick,
  disabled = false,
  isLoading = false,
  loadingText,
  variant = 'primary',
  size = 'sm',
  className = '',
  style = {}
}: MotionButtonProps) {
  const isDisabled = disabled || isLoading
  const buttonText = isLoading ? (loadingText || 'Loading...') : children
  const colors = variants[variant]

  return (
    <motion.button
      className={`w-full text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${sizes[size]} ${className}`}
      style={{ backgroundColor: colors.backgroundColor, ...style }}
      onClick={onClick}
      disabled={isDisabled}
      whileHover={
        !isDisabled
          ? { backgroundColor: colors.hoverColor, scale: 1.02 }
          : {}
      }
      whileTap={!isDisabled ? { scale: 0.98 } : {}}>
      {buttonText}
    </motion.button>
  )
}

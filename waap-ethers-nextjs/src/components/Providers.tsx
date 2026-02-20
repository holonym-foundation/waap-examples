'use client'

import { type ReactNode } from 'react'
import { WaaPProvider } from '@/waap.context'

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <WaaPProvider>
      {children}
    </WaaPProvider>
  )
}

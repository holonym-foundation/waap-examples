'use client'

import Header from '@/components/Header'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Slide, ToastContainer } from 'react-toastify'
import { WagmiProvider } from 'wagmi'
import './globals.css'
import { config } from '@/wagmi.config'

const queryClient = new QueryClient()

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en'>
      <body className={``}>
          <>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <Header />
              {children}
            </QueryClientProvider>
          </WagmiProvider>
          <ToastContainer transition={Slide} />
        </>
      </body>
    </html>
  )
}

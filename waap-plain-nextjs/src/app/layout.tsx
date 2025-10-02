'use client'

import Header from '@/components/Header'
import { Slide, ToastContainer } from 'react-toastify'
import { WaaPProvider } from '@/waap.context'
import './globals.css'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en'>
      <body className={``}>
        <WaaPProvider>
          <Header />
          {children}
          <ToastContainer transition={Slide} />
        </WaaPProvider>
      </body>
    </html>
  )
}

'use client'

import Header from '@/components/Header'
import { Slide, ToastContainer } from 'react-toastify'
import './globals.css'
import Providers from '@/components/Providers'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en'>
      <body className={``}>
          <>
          <Providers>
            <Header />
            {children}
          </Providers>
          <ToastContainer transition={Slide} />
        </>
      </body>
    </html>
  )
}

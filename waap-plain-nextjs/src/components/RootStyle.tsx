import React from 'react'

export default function RootStyle({ children }: { children: React.ReactNode }) {
  return (
    <div className='flex items-center min-h-[100vh] justify-center bg-gray-100'>
      <div className='w-[360px] mb-10 relative font-sans rounded-3xl border-[#E7E7E7] bg-white shadow-[0px_2px_16px_0px_rgba(0,0,0,0.04)]'>
        {children}
      </div>
    </div>
  )
}

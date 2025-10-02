# WaaP Example: Wagmi + Next.js

A comprehensive example of integrating WaaP with Next.js using Wagmi v2 and the `@human.tech/waap-sdk`.

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-wagmi-nextjs
cd waap-wagmi-nextjs
npm install
npm run dev
```

## Overview

This example demonstrates how to:
- WaaP as a custom Wagmi connector
- Connect and disconnect wallet using Wagmi hooks
- Sign messages with `useSignMessage` hook
- Send transactions with `useSendTransaction` hook
- Switch chains with `useSwitchChain` hook
- Calling WaaP specific methods via connector
- Handle wallet events and state with Wagmi
- Use React Query for data fetching and caching

## Features

- ✅ **WaaP Integration**: Custom Wagmi connector for WaaP SDK
- ✅ **Wagmi v2**: Full Wagmi integration with React hooks
- ✅ **Custom Connector**: `waap.connector.ts` with WaaP methods
- ✅ **Wagmi Hooks**: `useAccount`, `useConnect`, `useSignMessage`, etc. can be used
- ✅ **React Query**: Built-in caching and state management
- ✅ **Error Handling**: Robust error handling with loading states
- ✅ **TypeScript**: Full TypeScript support with proper types
- ✅ **Modern UI**: Clean, responsive interface with animations

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Animations**: Framer Motion
- **Wallet**: WaaP SDK (`@human.tech/waap-sdk`)

## Getting Started

1. **Install dependencies**
   ```bash
   pnpm install
   # or
   npm install
   ```

2. **Run the development server**
   ```bash
   pnpm dev
   # or
   npm run dev
   ```

3. **Open your browser**
   
   Navigate to [http://localhost:3000](http://localhost:3000)

## Configuration

The WaaP connector for Wagmi is configured in `src/wagmi.config.ts`:

```typescript
import WaaPConnector from "./waap.connector"
import { walletConnect } from "wagmi/connectors"

export const WaaPConfig: InitWaaPOptions = {
  useStaging: true, // Set to false for production
  config: {
    allowedSocials: ["google", "twitter", "discord", "github"],
    authenticationMethods: ["email", "phone", "social"],
    styles: {
      darkMode: false,
    },
  },
  project: {
    entryTitle: "Welcome Human",
  },
}

export const config = createConfig({
  chains: [sepolia, mainnet, optimism, zksync, polygon, gnosis, baseSepolia],
  connectors: [
    WaaPConnector(WaaPConfig),
    walletConnect({
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
    }),
  ],
  transports: {
    [sepolia.id]: http(),
    [mainnet.id]: http(),
    // ... other chains
  },
})
```

## Key Files

- `src/waap.connector.ts` - Custom Wagmi connector for WaaP
- `src/waap.config.ts` - WaaP configuration
- `src/wagmi.config.ts` - Wagmi configuration with WaaP connector
- `src/app/page.tsx` - Main page with Wagmi hooks
- `src/components/methods/` - Wallet method components using Wagmi hooks

## Usage

### Basic Wallet Connection with Wagmi

```typescript
import { useAccount, useConnect, useDisconnect } from 'wagmi'

function MyComponent() {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()

  const handleConnect = () => {
    const WaaPConnector = connectors.find(c => c.id === 'waap')
    if (WaaPConnector) {
      connect({ connector: WaaPConnector })
    }
  }

  return (
    <div>
      {isConnected ? (
        <div>
          <p>Connected: {address}</p>
          <button onClick={() => disconnect()}>Disconnect</button>
        </div>
      ) : (
        <button onClick={handleConnect} disabled={isPending}>
          {isPending ? 'Connecting...' : 'Connect Wallet'}
        </button>
      )}
    </div>
  )
}
```

### Signing Messages with Wagmi

```typescript
import { useSignMessage, useAccount } from 'wagmi'
import { useEffect, useState } from 'react'

function SignMessage() {
  const [message, setMessage] = useState('Hello Human!')
  const { isConnected } = useAccount()
  const { signMessage, isPending, data } = useSignMessage()

  useEffect(() => {
    if (data) {
      console.log('Signature:', data)
    }
  }, [data])

  const handleSignMessage = async () => {
    if (!isConnected) return
    
    try {
      await signMessage({ message })
    } catch (error) {
      console.error('Signing failed:', error)
    }
  }

  return (
    <div>
      <input 
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Enter message to sign..."
      />
      <button 
        onClick={handleSignMessage} 
        disabled={!isConnected || isPending}
      >
        {isPending ? 'Signing...' : 'Sign Message'}
      </button>
      {data && <div>Signature: {data}</div>}
    </div>
  )
}
```

### Sending Transactions with Wagmi

```typescript
import { useSendTransaction, useAccount } from 'wagmi'
import { parseEther } from 'viem'

function SendTransaction() {
  const { isConnected } = useAccount()
  const { sendTransaction, isPending, data, error } = useSendTransaction()

  const handleSendTransaction = async () => {
    if (!isConnected) return

    try {
      await sendTransaction({
        to: '0x742d35Cc6634C0532925a3b8D400e9a1E0F75Ff5',
        value: parseEther('0.001'),
      })
    } catch (error) {
      console.error('Transaction failed:', error)
    }
  }

  return (
    <div>
      <button 
        onClick={handleSendTransaction} 
        disabled={!isConnected || isPending}
      >
        {isPending ? 'Sending...' : 'Send 0.001 ETH'}
      </button>
      {data && <div>Transaction hash: {data}</div>}
      {error && <div>Error: {error.message}</div>}
    </div>
  )
}
```

### Calling WaaP Specific Methods

```typescript
import { useAccount } from 'wagmi'
import { isWaaPConnector } from '@/waap.connector'
import { useState } from 'react'

function RequestEmail() {
  const [result, setResult] = useState('')
  const { isConnected, connector } = useAccount()

  const handleRequestEmail = async () => {
    if (!isConnected || !isWaaPConnector(connector)) {
      console.error('WaaP connector not found')
      return
    }

    try {
      const email = await connector.requestEmail()
      setResult(JSON.stringify(email, null, 2))
      console.log('Email:', email)
    } catch (error) {
      console.error('Failed to request email:', error)
    }
  }

  return (
    <div>
      <button onClick={handleRequestEmail} disabled={!isConnected}>
        Request Email
      </button>
      {result && <pre>{result}</pre>}
    </div>
  )
}
```

## Environment

- **Staging**: Uses WaaP staging environment by default
- **Production**: Change `useStaging: false` in config for production

## License

MIT
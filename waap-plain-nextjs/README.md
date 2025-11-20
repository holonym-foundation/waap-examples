# WaaP Example: Plain + Next.js

A clean example of integrating WaaP with Next.js using the `@human.tech/waap-sdk` with just `window.waap` withount any other adapters.

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-plain-nextjs
cd waap-plain-nextjs
npm install
npm run dev
```

## Overview

This example demonstrates how to:
- Initialize WaaP with `initWaaP`
- Connect and disconnect wallet
- Sign messages
- Send transactions
- Switch chains
- Calling WaaP methods
- Handle wallet events and state management

## Features

- ✅ **WaaP Integration**: Full integration with WaaP SDK
- ✅ **Auto-initialization**: Automatically detects extension or initializes with `initWaaP`
- ✅ **Event Handling**: Proper wallet event listeners
- ✅ **Error Handling**: Robust error handling and user feedback
- ✅ **TypeScript**: Full TypeScript support
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

The WaaP is configured in `src/waap.config.ts`:

```typescript
export const WaaPConfig: InitWaaPOptions = {
  useStaging: false, // Set to false for production
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
```

## Key Files

- `src/waap.context.tsx` - WaaP context and logic
- `src/waap.config.ts` - WaaP configuration
- `src/app/page.tsx` - Main page with method components
- `src/components/methods/` - Wallet method components - 1 method is 1 component for easier reference

## Usage

### Basic Wallet Connection

```typescript
import { useWaaP } from '@/waap.context'

function MyComponent() {
  const { 
    isInitialized,
    isConnected, 
    isConnecting,
    address, 
    chainId,
    connect, 
    disconnect
  } = useWaaP()

  const handleSignMessage = async () => {
    if (!window.waap || !address) return

    try {
      const signature = await window.waap.request({
        method: 'personal_sign',
        params: ['Hello Human!', address]
      })
      console.log('Signature:', signature)
    } catch (error) {
      console.error('Signing failed:', error)
    }
  }

  if (!isInitialized) return <div>Initializing WaaP...</div>

  return (
    <div>
      {isConnected ? (
        <div>
          <p>Connected: {address}</p>
          <p>Chain ID: {chainId}</p>
          <button onClick={disconnect}>Disconnect</button>
          <button onClick={handleSignMessage}>Sign Message</button>
        </div>
      ) : (
        <button onClick={connect} disabled={isConnecting}>
          {isConnecting ? 'Connecting...' : 'Connect Wallet'}
        </button>
      )}
    </div>
  )
}
```

### Sending Transactions

```typescript
import { useWaaP } from '@/waap.context'

function SendTransaction() {
  const { isConnected, address } = useWaaP()

  const handleSendTransaction = async () => {
    if (!window.waap || !address) return

    try {
      const txHash = await window.waap.request({
        method: 'eth_sendTransaction',
        params: [{
          from: address,
          to: "0x742d35Cc6634C0532925a3b8D400e9a1E0F75Ff5",
          value: "0x38D7EA4C68000", // 0.001 ETH in hex
        }]
      })
      console.log('Transaction sent:', txHash)
    } catch (error) {
      console.error('Transaction failed:', error)
    }
  }

  return (
    <button onClick={handleSendTransaction} disabled={!isConnected}>
      Send 0.001 ETH
    </button>
  )
}
```

### Calling a WaaP specific method

```typescript
function RequestEmail() {
  const { isConnected } = useWaaP()

  const handleRequestEmail = async () => {
    if (!window.waap) return

    try {
      // Access WaaP specific methods
      const email = await window.waap.requestEmail()
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
    </div>
  )
}
```

## Environment

- **Staging**: Uses WaaP staging environment by default
- **Production**: Change `useStaging: false` in config for production

## License

MIT
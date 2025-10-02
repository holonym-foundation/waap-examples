# WaaP Example: Ethers.js + Next.js

A comprehensive example of integrating WaaP with Next.js using Ethers.js v6 and the `@human.tech/waap-sdk`.

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-ethers-nextjs
cd waap-ethers-nextjs
npm install
npm run dev
```

## Overview

This example demonstrates how to:
- Initialize WaaP as Ethers provider and signer
- Connect and disconnect wallet using Ethers.js v6
- Create BrowserProvider and JsonRpcSigner instances
- Sign messages with Ethers
- Send transactions using Ethers
- Switch chains
- Calling WaaP methods
- Handle wallet events and state management

## Features

- ✅ **WaaP Integration**: Full integration with WaaP SDK
- ✅ **Ethers.js v6**: WaaP as Ethers provider and signer
- ✅ **Auto-initialization**: Automatically detects existing connection
- ✅ **waap.context**: Prebuilt context for WaaP: `WaaPProvider`, `useWaaP`
- ✅ **Event Handling**: Proper wallet event listeners for account and chain changes
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

The WaaP is configured in `src/waap.config.ts`:

```typescript
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
```

## Key Files

- `src/waap.context.tsx` - Main WaaP context and logic
- `src/waap.config.ts` - WaaP configuration
- `src/app/page.tsx` - Main page with method components
- `src/components/methods/` - Wallet method components - 1 method is 1 component for easier reference

## Usage

### Basic Wallet Connection

```typescript
import { useWaaP } from '@/waap.context'

function MyComponent() {
  const { 
    isConnected, 
    isConnecting,
    isLoading,
    address, 
    provider,
    signer,
    error,
    connect, 
    disconnect
  } = useWaaP()

  if (isLoading) return <div>Loading...</div>
  if (error) return <div>Error: {error}</div>

  const handleSignMessage = const handleSignMessage = async () => {
    const signature = signer.signMessage('hello human!')
    console.log('Signature:', signature)
  }

  return (
    <div>
      {isConnected ? (
        <div>
          <p>Connected: {address}</p>
          <button onClick={disconnect}>Disconnect</button>
          <button onClick={handleSignMesage}>Sign Message</button>
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

### Using Ethers.js for Transactions

```typescript
import { useWaaP } from '@/waap.context'
import { parseEther } from 'ethers'

function SendTransaction() {
  const { signer, address } = useWaaP()

  const handleSendTransaction = async () => {
    if (!signer) return

    try {
      const tx = await signer.sendTransaction({
        to: "0x742d35Cc6634C0532925a3b8D400e9a1E0F75Ff5",
        value: parseEther("0.001"),
      })
      
      console.log('Transaction sent:', tx.hash)
      await tx.wait()
      console.log('Transaction confirmed!')
    } catch (error) {
      console.error('Transaction failed:', error)
    }
  }

  return (
    <button onClick={handleSendTransaction}>
      Send 0.001 ETH
    </button>
  )
}
```

### Calling a WaaP method

```typescript
import { useWaaP } from '@/waap.context'

function RequestEmail() {
  const { provider, signer } = useWaaP()

  const handleSendTransaction = async () => {
    if (!signer) return

    const email = await provider.requestEmail()
    console.log('Email:', email)
  }

  return (
    <button onClick={handleRequestEmail}>
      Request Email
    </button>
  )
}
```

## Environment

- **Staging**: Uses WaaP staging environment by default
- **Production**: Change `useStaging: false` in config for production

## License

MIT
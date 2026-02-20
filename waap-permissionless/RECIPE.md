---
title: Smart Accounts with Permissionless.js
description: Learn how to create ERC-4337 Smart Accounts using WaaP as the signer and Permissionless.js for bundling and paymaster services.
---

# Smart Accounts with Permissionless.js

> **Note**: This recipe uses [Permissionless.js](https://docs.pimlico.io/permissionless) v0.3 to create Simple Accounts (ERC-4337) with WaaP as the owner.

Integrating Account Abstraction (ERC-4337) allows you to offer gasless transactions, batch operations, and enhanced security. With WaaP's 2PC-MPC security acting as the signer, you get the best of both worlds: a non-custodial, recoverable signer controlling a powerful smart account.

## What are we cooking?

A Next.js application based on the [WaaP Wagmi Starter](https://github.com/holonym-foundation/waap-examples/tree/main/waap-wagmi-nextjs) that connects WaaP to Permissionless.js, enabling users to:
- Automatically deploy a Simple Account
- Send sponsored transactions (zero gas for the user)
- Batch multiple transactions into a single UserOperation

## Key Components

- **WaaP**: Secure, non-custodial signer (Owner of the Smart Account)
- **Permissionless.js**: Library for building and managing ERC-4337 smart accounts
- **Pimlico**: Bundler and Paymaster provider (handles gas sponsorship)
- **Next.js API Route**: Securely proxies bundler and paymaster RPC calls so the Pimlico API key remains hidden from the frontend.

## Project Setup

### Get started with the WaaP Permissionless example

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-permissionless
cd waap-permissionless
pnpm install
```

### Configure Environment

You need a Pimlico API Key for the bundler and paymaster. Get one from the [Pimlico Dashboard](https://dashboard.pimlico.io).

```bash
cp .env.example .env
```

Add your key to `.env`:

```env
PIMLICO_API_KEY=your_pimlico_api_key
```

## Core Functionality

### Secure API Route Proxy

It's a security best practice to hide your Pimlico API key from the frontend clients. To achieve this, we can set up a Next.js backend API Route (`src/app/api/pimlico/route.ts`) to proxy our requests:

```typescript
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const apiKey = process.env.PIMLICO_API_KEY

    const response = await fetch(`https://api.pimlico.io/v2/sepolia/rpc?apikey=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    return NextResponse.json(await response.json())
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
```

### Build the Smart Account Client

We create a helper function that takes the WaaP `WalletClient` (from wagmi) and creates a `SmartAccountClient`. The WaaP wallet acts as the **owner** of the `SimpleAccount`.

```typescript
// src/lib/permissionless.ts
import { createSmartAccountClient, toOwner } from 'permissionless'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import type { WalletClient, Transport, Chain, Account } from 'viem'

export async function buildSmartAccountClient(walletClient: WalletClient) {
  // Use our secure internal Next.js API route 
  const proxyUrl = '/api/pimlico'

  // 1. Create Paymaster Client routing through our proxy
  const paymasterClient = createPimlicoClient({
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    transport: http(proxyUrl),
  })

  if (!walletClient.account) {
    throw new Error('Wallet client must have an account')
  }

  const smartAccountSigner = await toOwner({
    owner: walletClient as WalletClient<Transport, Chain, Account>
  })

  // 2. Create Simple Account with WaaP as owner
  const simpleAccount = await toSimpleSmartAccount({
    client: publicClient,
    owner: smartAccountSigner, 
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })

  // 3. Create Smart Account Client
  return createSmartAccountClient({
    account: simpleAccount,
    chain: sepolia, // Using Sepolia for testing
    bundlerTransport: http(proxyUrl),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  })
}
```

### Using the Smart Account in React

We can wrap this logic in a hook `useSmartAccount` that listens for the WaaP connection and initializes the smart account.

```typescript
// src/hooks/useSmartAccount.ts
import { useWalletClient } from 'wagmi'

export function useSmartAccount() {
  const { data: walletClient } = useWalletClient()
  // ... state management ...

  useEffect(() => {
    if (walletClient) {
      // The API key is now securely maintained on the server
      buildSmartAccountClient(walletClient).then(client => {
        setSmartAccountClient(client)
        setSmartAddress(client.account.address)
      })
    }
  }, [walletClient])
  
  return { smartAccountClient, smartAddress }
}
```

### Sending a Sponsored Transaction

With the `smartAccountClient`, sending a transaction is as simple as calling `sendTransaction`. The Paymaster configuration ensures it is gasless for the user.

```typescript
const handleSendUserOp = async () => {
  const txHash = await smartAccountClient.sendTransaction({
    to: '0xTargetAddress...',
    value: parseEther('0'), // or any amount
    data: '0x' // or encoded function data
  })
  console.log('UserOp Hash:', txHash)
}
```

### Batch Transactions

You can batch multiple operations into a single transaction (UserOp), saving time and improving UX.

```typescript
const handleBatchUserOp = async () => {
  const txHash = await smartAccountClient.sendTransaction({
    calls: [
      {
        to: '0xTarget1...',
        value: parseEther('0.1')
      },
      {
        to: '0xTarget2...',
        data: encodeFunctionData({ ... })
      }
    ]
  })
  console.log('Batch Hash:', txHash)
}
```

## Security Considerations

- **Bundler & Paymaster**: Ensure your API keys are protected or restricted to specific domains if used on the frontend.
- **Owner Security**: The security of the smart account depends on the owner (WaaP). WaaP's 2PC-MPC ensures the owner key is secure.
- **Entrypoint**: We use Entrypoint v0.7. Ensure compatibility with your account contracts.

## Conclusion

Combining WaaP with Permissionless.js creates a powerful, user-friendly onboarding experience. Users get the ease of social login (WaaP) and the power of Account Abstraction (gasless, batching) via Permissionless.js.

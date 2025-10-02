# WaaP - https://waap.xyz
## Quick Start Examples

A few quick start examples are available below to make integration even easier.

- [Plain (`window.waap`) + Next.js](#plain--nextjs)
- [Wagmi + Next.js](#wagmi--nextjs)
- [Ethers + Next.js](#ethers-v6--nextjs)

There are helper files created to make integration snappy. Simply copy and paste relevant files into your project and you're good to go.

Some wallet specific methods and EIP-1193 methods are implemented in `/components/methods/` folder. 1 method per component for easier reference.

### Plain + Next.js

[→ View source code](./waap-plain-nextjs)

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-plain-nextjs
cd waap-plain-nextjs
npm install
npm run dev
```

This quick start example uses `window.wapp` directly (without other adapters) and Next.js.

Just copy `waap.config.ts` and `waap.context.tsx` files from the example. You can get started immediately in your React and Next.js app.

And then use `WaaPProvider` in your app layout file.

```typescript
import { WaaPProvider } from '@/waap.context'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en'>
      <body className={``}>
        <WaaPProvider>
          {children}
        </WaaPProvider>
      </body>
    </html>
  )
}
```

And then use `useWaaP` hook in your components to get the user's wallet addresses.

```typescript
import { useWaaP } from '@/waap.context'

export default function Home() {
  const { address } = useWaaP()
  return <div>Connected: {address}</div>
}
```

### Wagmi + Next.js

[→ View source code](./waap-wagmi-nextjs)

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-wagmi-nextjs
cd waap-wagmi-nextjs
npm install
npm run dev
```

This quick start example uses Wagmi v2 with a custom Human Wallet connector and Next.js.

Just copy `wagmi.config.ts`, `waap.config.ts` and `waap.connector.ts` files from the example. You can get started immediately in your React and Next.js app.

And then use `WagmiProvider` with the custom connector in your app layout file.

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'

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
              {children}
            </QueryClientProvider>
          </WagmiProvider>
        </>
      </body>
    </html>
  )
}
```

And then use wagmi hooks accordingly. For example, here is how to sign message.

```typescript
import { useAccount, useSignMessage } from 'wagmi'

export default function SignMessage() {

  const { signMessage, isPending, data } = useSignMessage()

  return (
    <div>
      <button onClick={() => signMessage({ message: 'Hello from Human Wallet!' })}>Sign Message</button>
      {isPending && <div>Signing...</div>}
      {data && <div>Signature: {data}</div>}
    </div>
  )
}
```
### Ethers v6 + Next.js

[→ View source code](./waap-ethers-nextjs)

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-ethers-nextjs
cd waap-ethers-nextjs
npm install
npm run dev
```

This quick start example uses Ethers.js v6 with Human Wallet as a BrowserProvider and Next.js.

Just copy `ethers.config.ts`, `waap.config.ts` and `waap.context.tsx` files from the example. You can get started immediately in your React and Next.js app.

And then use `WaaPProvider` in your app layout file.

```typescript
import { WaaPProvider } from '@/waap.context'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='en'>
      <body className={``}>
        <WaaPProvider>
          {children}
        </WaaPProvider>
      </body>
    </html>
  )
}
```

And then use ethers provider and signer accordingly. For example, here is how to sign message.

```typescript
const { isConnected, provider, signer } = useWaaP()

export default function SignMessage() {

  return (
    <div>
      <button onClick={async () => { const signature = await signer.signMessage('Hello from WaaP!'); console.log(signature); }}>Sign Message</button>
    </div>
  )
}
```
---

## Other Examples and Templates

- **[welcome.human.tech App](https://welcome.human.tech/)** - A complete Next.js application showcasing Human Wallet + Human Passport integration with modern UI/UX, multi-chain support, and production-ready features. ([source](https://github.com/holonym-foundation/welcome.human.tech))
- **[Quilombo](https://quilombo.vercel.app)** by [j-h-scheufen](https://github.com/j-h-scheufen) ([source](https://github.com/j-h-scheufen/axedao))
- **[WaaP Demo App](https://silk-demo-app.vercel.app/)** - Full-featured demo showcasing all functionality ([source](https://github.com/holonym-foundation/silk-demo-app))
- **[Next.js + Viem Template](https://silk-template.vercel.app/)** - Template app using Human Wallet and Viem by [nestorbonilla](https://github.com/nestorbonilla) ([source](https://github.com/nestorbonilla/silk-template))

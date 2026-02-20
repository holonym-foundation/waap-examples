import { http, createPublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { createSmartAccountClient, toOwner } from 'permissionless'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import type { WalletClient, Transport, Chain, Account } from 'viem'

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(),
})

export async function buildSmartAccountClient(walletClient: WalletClient) {
  // Use our internal Next.js API route instead of exposing the Pimlico API key to the frontend
  const proxyUrl = '/api/pimlico'

  // 1. Pimlico client for gas estimation + paymaster
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

  // 2. Simple smart account — walletClient (from wagmi useWalletClient) is the owner
  const simpleAccount = await toSimpleSmartAccount({
    client: publicClient,
    owner: smartAccountSigner,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })

  // 3. Smart account client
  return createSmartAccountClient({
    account: simpleAccount,
    chain: sepolia,
    bundlerTransport: http(proxyUrl),
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  })
}

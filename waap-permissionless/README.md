# WaaP + Permissionless Example

This example demonstrates how to use [WaaP SDK](https://docs.waap.xyz) with [Permissionless.js](https://docs.pimlico.io/permissionless) to create ERC-4337 Smart Accounts.

The WaaP wallet acts as the **signer (owner)** of the smart account, while Permissionless.js and Pimlico handle the bundling and paymaster services.

## Features

- **Connect with WaaP**: Authenticate using Email, Socials, or Passkeys.
- **Smart Account Creation**: Automatically generates a Simple Account (ERC-4337) with the WaaP wallet as the signer.
- **Sponsored Transactions**: Sends UserOperations (UserOps) sponsored by Pimlico Paymaster (zero gas for the user).
- **ERC-20 Gas Payments**: Send UserOperations where the gas fees are paid using ERC-20 tokens (e.g. USDC) instead of native ETH.
- **Batch Transactions**: meaningful example of batching multiple calls into a single UserOp.

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Set up environment variables:
   Copy `.env.example` to `.env` and add your Pimlico API Key (get one from [dashboard.pimlico.io](https://dashboard.pimlico.io)).
   ```bash
   cp .env.example .env
   ```
   ```env
   PIMLICO_API_KEY=your_api_key
   ```

## Run

```bash
pnpm dev
```

## Learn More

- [WaaP Documentation](https://docs.waap.xyz)
- [Permissionless.js Documentation](https://docs.pimlico.io/permissionless)
- [Pimlico](https://pimlico.io)
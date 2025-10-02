# WaaP Recipes

A comprehensive demo of various [WaaP recipes](https://docs.wallet.human.tech/docs/category/recipes) started off from _WaaP quick start example_ of WAGMI and Next.js.

```bash
npx gitpick holonym-foundation/waap-examples/tree/main/waap-recipes
cd waap-recipes
npm install
npm run dev
```

## Overview

We believe in supporting our partners to build their ideas quickly. 

Hence, we will be adding recipes with code examples on regular basis.

Please refer to https://docs.wallet.human.tech/docs/category/recipes for all our recipes.

## How is this project structured

- Started with _WaaP quick start example_ of WAGMI and Next.js
- `src/app/page.tsx` is the home page
- Each recipe demo is on a separate page: `src/app/[recipe]/page.tsx`

## Recipes

- Stablecoins: `src/app/yield/page.tsx`
- Yield farming: `src/app/yield/page.tsx`
- Swapping tokens: `src/app/swap/page.tsx`

## Environment

- **Staging**: Uses WaaP staging environment by default
- **Production**: Change `useStaging: false` in config for production

## License

MIT
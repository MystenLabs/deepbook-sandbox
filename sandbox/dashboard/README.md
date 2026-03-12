# DeepBook Sandbox Dashboard

Web dashboard for monitoring and interacting with a DeepBook V3 sandbox environment.

## Features

- **Health** — Real-time status of Sui node, oracle, market maker, faucet, and indexer (auto-refreshes every 10 s)
- **Market Maker** — Order book bar chart, active bid/ask levels, and grid configuration
- **Faucet** — Request SUI and DEEP tokens to a connected wallet (requires Sui wallet)
- **Deployment** — Browse deployed package IDs, pool addresses, and Pyth oracle objects with explorer links

## Tech Stack

React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui, Recharts, `@mysten/dapp-kit`, React Query.

## Getting Started

```bash
cd sandbox/dashboard
pnpm install
pnpm dev          # http://localhost:5173
```

The dev server proxies API requests to the sandbox services:

| Path            | Target           | Service          |
| --------------- | ---------------- | ---------------- |
| `/api/sui`      | `localhost:9000` | Sui localnet RPC |
| `/api/oracle`   | `localhost:9010` | Oracle service   |
| `/api/mm`       | `localhost:3001` | Market maker     |
| `/api/faucet`   | `localhost:9009` | Faucet           |
| `/api/deepbook` | `localhost:9008` | DeepBook server  |

> Make sure the sandbox stack is running (`pnpm deploy-all` from `sandbox/`) before starting the dashboard.

## Build

```bash
pnpm build        # outputs to dist/
pnpm preview      # serve the production build locally
```

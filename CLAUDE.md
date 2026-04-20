# DeepBookV3 Sandbox

## Agent Guidelines

When making changes in this repository:

- Keep this file (`./CLAUDE.md`) up to date with any new patterns, commands, or architectural decisions.
- Spawn a review agent to review ongoing changes before completing.
- For git commits: keep titles short (sacrifice grammar for conciseness), but include detailed descriptions
  with one sentence explaining what the commit introduces/fixes, plus examples when helpful.

## Project Overview

This project provides a toolset for reducing builder friction with one-liner deployments, Dockerized stack, and a web dashboard for DeepBook V3 instances.

**DeepBookV3** is included as a git submodule at `./external/deepbook/`. It's a decentralized central limit order book (CLOB) built on Sui. Key resources:

- Submodule README: `./external/deepbook/README.md`
- Move code guidelines: `./external/deepbook/CLAUDE.md` (use `/deepbookv3` skill for comprehensive Move guidance)
- [Contract Documentation](https://docs.sui.io/standards/deepbookv3)
- [SDK Documentation](https://docs.sui.io/standards/deepbookv3-sdk)

## File Structure

```
deepbook-sandbox/
├── CLAUDE.md              # This file - agent instructions
├── README.md              # Project overview
├── sandbox/
│   ├── docker-compose.yml # Docker orchestration
│   ├── dashboard/         # Web dashboard (React SPA, Dockerized with nginx)
│   │   ├── Dockerfile
│   │   ├── nginx.conf     # Reverse-proxy config (replicates Vite dev proxy)
│   │   ├── package.json
│   │   └── src/           # React app source (Health, Market Maker, Trading, Faucet, Deployment)
│   ├── api/               # Sandbox API service (TypeScript/Hono) — faucet + manifest + service control
│   │   ├── Dockerfile     # Runtime image installs docker-cli for /services routes
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Server entry, /manifest endpoint, faucet + services routes
│   │       ├── config.ts          # Env validation, signer/client factories
│   │       ├── services/
│   │       │   ├── sui-faucet.ts  # Proxies to Sui's built-in faucet
│   │       │   └── deep-faucet.ts # Signs DEEP transfers from deployer
│   │       └── routes/
│   │           ├── faucet.ts      # POST /faucet endpoint
│   │           └── services.ts    # POST /services/:name/{stop,restart} — docker control via mounted socket
│   └── scripts/
│       ├── deploy-all.ts      # Deploy DeepBook to localnet
│       ├── down.ts            # Full teardown (containers, volumes, .env)
│       ├── market-maker/      # Market maker service (Dockerized)
│       │   ├── Dockerfile
│       │   ├── index.ts   # Entry point
│       │   ├── config.ts  # Zod config schema
│       │   ├── types.ts   # DeepBook constants
│       │   └── ...        # Grid strategy, order management, etc.
│       ├── oracle-service/        # Pyth price feed updater (Dockerized)
│       │   ├── Dockerfile
│       │   ├── index.ts           # Service loop + status HTTP server (port 9010)
│       │   ├── pyth-client.ts     # Pyth API client
│       │   ├── oracle-updater.ts  # On-chain update logic
│       │   ├── constants.ts       # Price feed IDs
│       │   └── types.ts           # TypeScript types
│       └── utils/         # Shared utilities
├── examples/
│   └── sandbox/           # SDK integration examples (@mysten/deepbook-v3)
│       ├── package.json   # Isolated package (uses @mysten/sui@v2, NOT v1)
│       ├── tsconfig.json
│       ├── setup.ts       # Shared: manifest loader, client factory, faucet, BM lifecycle
│       ├── check-order-book.ts   # Read-only: mid price + order book depth
│       ├── swap-tokens.ts        # Direct wallet swap SUI→DEEP (no BalanceManager)
│       ├── place-limit-order.ts  # Create BM, deposit, place resting limit bid
│       ├── place-market-order.ts # Create BM, deposit, market buy against MM
│       ├── query-user-orders.ts  # Place, query, cancel — full order lifecycle
│       └── README.md
└── external/
    └── deepbook/          # Git submodule - DeepBookV3 source
        ├── packages/      # Move smart contracts
        └── crates/        # Rust crates (indexer, API server)
```

## Docker Stack

Docker compose file: `./sandbox/docker-compose.yml`

Services in the stack:

| Service              | Profile    | Description                                        | Ports                         |
| -------------------- | ---------- | -------------------------------------------------- | ----------------------------- |
| **PostgreSQL**       | (always)   | Database for the indexer                           | 5432                          |
| **Sui Localnet**     | `localnet` | Local Sui blockchain for testing                   | 9000 (RPC), 9123 (faucet)     |
| **Market Maker**     | `localnet` | Automated market maker for DEEP/SUI + SUI/USDC     | 3001 (health), 9091 (metrics) |
| **DeepBook Indexer** | `localnet` | Indexes DeepBook events from checkpoints           | 9184 (metrics)                |
| **DeepBook Server**  | `localnet` | REST API for querying indexed data                 | 9008                          |
| **DeepBook Faucet**  | `localnet` | Distributes SUI (proxied) and DEEP tokens          | 9009                          |
| **Oracle Service**   | `localnet` | Updates Pyth price feeds for DEEP/SUI every 10s    | 9010 (status)                 |
| **Dashboard**        | `localnet` | Web UI for monitoring and interacting with sandbox | 5173 (HTTP)                   |

### Running the Stack

```bash
cd sandbox

# Start localnet, deploy contracts, start all services
pnpm deploy-all

# Full teardown (volumes, .env keys)
pnpm down

# Stop containers
docker compose --profile localnet down

# View logs
docker compose logs -f
docker compose logs -f market-maker       # Market maker logs only
```

> Run `pnpm deploy-all` to start localnet, deploy contracts, and automatically launch the oracle service and market maker containers with the correct env vars.

## Development Commands

### Sandbox Deployment

```bash
cd sandbox

# Deploy all contracts, start localnet + oracle service
pnpm deploy-all

# Stop all services
pnpm down

# Check oracle service status/prices
curl http://localhost:9010/

# View oracle service logs
docker compose logs -f oracle-service
```

### Git Submodules

```bash
# Initialize submodules after fresh clone
git submodule update --init --recursive

# Update submodule to latest
cd external/deepbook && git pull origin main
```

### DeepBookV3 Development

When working with Move code in `./external/deepbook/`:

```bash
cd external/deepbook/packages/deepbook
sui move build                              # Build the package
sui move test                               # Run tests
sui move test --skip-fetch-latest-git-deps  # Skip fetching deps if unchanged
bunx prettier-move -c *.move --write        # Format Move files
```

## Sandbox Scripts

```bash
cd sandbox

# Deploy DeepBook to localnet (starts containers, deploys packages, creates pools, starts MM)
pnpm deploy-all

# Full teardown (stops containers, removes volumes, cleans generated .env keys)
pnpm down
```

## Integration Tests

```bash
cd sandbox

# Run all integration tests
pnpm test:integration

# Run a specific test by filename pattern
pnpm test:integration deploy-all-e2e
pnpm test:integration deploy-pipeline
```

Test files live in `sandbox/scripts/__tests__/**/*.integration.test.ts`. Vitest runs with `singleFork: true` to prevent concurrent localnet instances.

**Key pattern — localnet key handling:** On localnet, `deploy-all.ts` always reads the container-generated key (from `deployments/.sui-keystore`) and calls `importKeyToHostCli()` to configure the host `sui` CLI. The `.env` `PRIVATE_KEY` is only a placeholder for `docker-compose.yml` variable validation (`${PRIVATE_KEY:?...}`). Tests that write a seed `.env` should include a placeholder `PRIVATE_KEY` but must not expect `deploy-all.ts` to use it — the container key always takes precedence on localnet.

**CI workflow:** `.github/workflows/integration-tests.yml` runs both test suites in a matrix (parallel runners). Triggers on PRs/pushes that touch `sandbox/` or `external/deepbook/`, plus `workflow_dispatch`. The `sui` CLI is extracted from the `mysten/sui-tools:compat` Docker image to match the localnet container version. On failure, Docker logs are uploaded as artifacts.

## Oracle Service

The oracle service (`./sandbox/scripts/oracle-service/`) runs as a Docker container and provides automated price feed updates for localnet testing:

- **Deployment**: Runs in Docker as part of the `localnet` profile, started automatically by `pnpm deploy-all`
- **Purpose**: Updates Pyth price oracle contracts for SUI, DEEP, and USDC every 10 seconds
- **Status endpoint**: `http://localhost:9010` — returns JSON with latest prices, update count, and errors
- **Data Source**: Fetches historical price data from Pyth Network API (24h ago)
- **Env vars** (set automatically by deploy-all):
  - `ORACLE_PRIVATE_KEY`: Dedicated Ed25519 keypair (auto-generated, avoids gas coin conflicts with market maker)
  - `PYTH_PACKAGE_ID`: Deployed pyth package address
  - `DEEP_PRICE_INFO_OBJECT_ID`: DEEP PriceInfoObject ID
  - `SUI_PRICE_INFO_OBJECT_ID`: SUI PriceInfoObject ID
  - `USDC_PRICE_INFO_OBJECT_ID`: USDC PriceInfoObject ID
- **Price Feeds**:
  - SUI: `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`
  - DEEP: `0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff`
  - USDC: `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a`
- **Files**:
  - `index.ts`: Main service loop + status HTTP server
  - `pyth-client.ts`: Pyth API client
  - `oracle-updater.ts`: On-chain update logic
  - `types.ts`: TypeScript types
  - `Dockerfile`: Container image definition

See [./sandbox/scripts/oracle-service/README.md](./sandbox/scripts/oracle-service/README.md) for detailed documentation.

### Market Maker Configuration

Environment variables for `pnpm market-maker`:

- `MM_SPREAD_BPS` - Spread in basis points (default: 10 = 0.1%)
- `MM_LEVELS_PER_SIDE` - Orders per side (default: 5)
- `MM_ORDER_SIZE_BASE` - Order size in base asset units (default: 10_000_000 = 10 DEEP)
- `MM_REBALANCE_INTERVAL_MS` - Rebalance interval (default: 10000)
- `MM_HEALTH_CHECK_PORT` - Health server port (default: 3000)
- `MM_METRICS_PORT` - Prometheus metrics port (default: 9090)

See `sandbox/scripts/market-maker/README.md` for full documentation.

## Key Concepts

- **Balance Manager**: Shared object holding all balances for an account (1 owner, up to 1000 traders).
- **Pool**: Contains Book (order matching), State (user data, volumes, governance), and Vault (settlement).
- **DEEP Token**: Required for trading fees; can be staked for reduced fees and governance participation.

## Trading Page (Dashboard)

The dashboard's Trading page is the user-facing interface for the deepbook protocol. Architecture notes for agents working in this area:

- **BM creation is user-driven, not deploy-time.** `pnpm deploy-all` no longer auto-creates a BalanceManager. Instead, users click "Create Balance Manager" on the Trading page, which builds a single PTB containing `balance_manager::new_with_custom_owner` + `register_balance_manager` + `public_share_object`. Two are SDK helpers (`createBalanceManagerWithOwner`, `shareBalanceManager`); the middle one is a raw `moveCall` because the SDK's `registerBalanceManager` helper takes a config-lookup key and can't reference a freshly-created BM ref.
- **BM discovery is on-chain.** The dashboard calls `client.deepbook.getBalanceManagerIds(address)` (which simulates a tx against `registry::get_balance_manager_ids`) to find the user's registered BMs. No env var, no localStorage, no API endpoint. The deepbook Registry's owner→BM map is the single source of truth.
- **The registry's BM map must be initialized first.** `init_balance_manager_map` is an admin-gated one-time call that creates the dynamic field `register_balance_manager` writes into. We bundle that call into `createDeepbookPools` (`sandbox/scripts/utils/pool.ts`) so it runs as part of `pnpm deploy-all`. It's idempotent (`if !exists`), so re-running deploy-all is safe.
- **Wallet swap correctness:** the BM discovery query is keyed by `account?.address`, and the BM-balances / open-orders queries are keyed by `balanceManagerId`. Disconnecting Wallet A and connecting Wallet B immediately re-runs discovery and shows the empty state for B until B creates its own BM.
- **Trading hooks live at** `sandbox/dashboard/src/components/trading/hooks.ts` — read this file before touching any trading flow. `useCreateBalanceManager` is the canonical BM-creation path; do not duplicate it elsewhere.

## SDK Integration Examples

`examples/sandbox/` contains runnable TypeScript examples using the `@mysten/deepbook-v3` SDK. These demonstrate how external developers integrate with DeepBook — the pattern real builders would follow.

Both `examples/sandbox/` and the sandbox dashboard use `@mysten/sui@v2` and the new SDK extension pattern (`client.$extend(deepbook(...))`). The examples have their own `package.json` and `node_modules/` for isolation, but the SDK version is the same as the rest of the project.

```bash
# Run examples (sandbox must be running first)
cd examples/sandbox
pnpm install
pnpm check-order-book     # Read-only queries
pnpm swap-tokens           # Direct wallet swap
pnpm place-limit-order     # BalanceManager + limit order
pnpm place-market-order    # Market order (needs MM running)
pnpm query-user-orders     # Full order lifecycle
```

Key architecture decisions:

- Uses `$extend` pattern with `SuiGrpcClient` (official Sui v2 SDK pattern)
- Reads deployment manifest from `sandbox/deployments/localnet.json` (written by `pnpm deploy-all`)
- Constructs `CoinMap`, `PoolMap`, and `DeepbookPackageIds` at runtime from the manifest
- Fresh keypair per run, funded via sandbox faucet (port 9009) — avoids gas conflicts with MM

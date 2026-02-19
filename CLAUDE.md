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
│   ├── deployments/       # Deployment manifests (generated)
│   ├── faucet/            # Faucet service (TypeScript/Hono)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Server entry, health check
│   │       ├── config.ts          # Env validation, signer/client factories
│   │       ├── services/
│   │       │   ├── sui-faucet.ts  # Proxies to Sui's built-in faucet
│   │       │   └── deep-faucet.ts # Signs DEEP transfers from deployer
│   │       └── routes/
│   │           └── faucet.ts      # POST /faucet endpoint
│   └── scripts/
│       ├── deploy-all.ts      # Deploy DeepBook to localnet
│       ├── seed-liquidity.ts  # One-shot initial liquidity seeding
│       ├── down.ts            # Stop localnet containers
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
└── external/
    └── deepbook/          # Git submodule - DeepBookV3 source
        ├── packages/      # Move smart contracts
        └── crates/        # Rust crates (indexer, API server)
```

## Docker Stack

Docker compose file: `./sandbox/docker-compose.yml`

Services in the stack:

| Service              | Profile              | Description                                     | Ports                         |
| -------------------- | -------------------- | ----------------------------------------------- | ----------------------------- |
| **PostgreSQL**       | (always)             | Database for the indexer                        | 5432                          |
| **Sui Localnet**     | `localnet`           | Local Sui blockchain for testing                | 9000 (RPC), 9123 (faucet)     |
| **Market Maker**     | `localnet`           | Automated market maker for DEEP/SUI pool        | 3001 (health), 9091 (metrics) |
| **DeepBook Indexer** | `remote`             | Indexes DeepBook events (testnet/mainnet only)  | 9184 (metrics)                |
| **DeepBook Server**  | `remote`             | REST API for querying indexed data              | 9008                          |
| **DeepBook Faucet**  | `localnet`, `remote` | Distributes SUI (proxied) and DEEP tokens       | 9009                          |
| **Oracle Service**   | `localnet`           | Updates Pyth price feeds for DEEP/SUI every 10s | 9010 (status)                 |

> **Note:** The indexer only supports testnet/mainnet (hardcoded checkpoint URLs). It cannot index a local Sui node.

### Running the Stack

```bash
cd sandbox

# Testnet/Mainnet (full indexer stack)
docker compose --profile remote up -d
docker compose --profile remote down      # Stop services
docker compose --profile remote down -v   # Fresh start (remove volumes)

# Localnet (Sui node + oracle + market maker)
pnpm deploy-all                           # Start localnet, deploy contracts, start services
docker compose --profile localnet down

# Stop all services (any profile)
docker compose --profile remote --profile localnet down

# View logs
docker compose logs -f
docker compose logs -f market-maker       # Market maker logs only
```

> **Localnet workflow:** Run `pnpm deploy-all` to start localnet, deploy contracts, and automatically launch the oracle service and market maker containers with the correct env vars.

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

# Deploy DeepBook to localnet (starts containers, deploys Move packages, creates DEEP/SUI pool, seeds liquidity)
pnpm deploy-all

# Seed initial liquidity into the latest deployed pool (standalone, runs once and exits)
pnpm seed-liquidity

# Stop localnet containers
pnpm down
```

## Oracle Service

The oracle service (`./sandbox/scripts/oracle-service/`) runs as a Docker container and provides automated price feed updates for localnet testing:

- **Deployment**: Runs in Docker as part of the `localnet` profile, started automatically by `pnpm deploy-all`
- **Purpose**: Updates Pyth price oracle contracts for SUI and DEEP every 10 seconds
- **Status endpoint**: `http://localhost:9010` — returns JSON with latest prices, update count, and errors
- **Data Source**: Fetches historical price data from Pyth Network API (24h ago)
- **Env vars** (set automatically by deploy-all):
  - `ORACLE_PRIVATE_KEY`: Dedicated Ed25519 keypair (auto-generated, avoids gas coin conflicts with market maker)
  - `PYTH_PACKAGE_ID`: Deployed pyth package address
  - `DEEP_PRICE_INFO_OBJECT_ID`: DEEP PriceInfoObject ID
  - `SUI_PRICE_INFO_OBJECT_ID`: SUI PriceInfoObject ID
- **Price Feeds**:
  - SUI: `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`
  - DEEP: `0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff`
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

- **Balance Manager**: Shared object holding all balances for an account (1 owner, up to 1000 traders)
- **Pool**: Contains Book (order matching), State (user data, volumes, governance), and Vault (settlement)
- **DEEP Token**: Required for trading fees; can be staked for reduced fees and governance participation

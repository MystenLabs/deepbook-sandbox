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
│   └── scripts/
│       ├── deploy-all.ts      # Deploy DeepBook to localnet
│       ├── seed-liquidity.ts  # One-shot initial liquidity seeding
│       ├── down.ts            # Stop localnet containers
│       ├── market-maker/      # Market maker service
│       │   ├── index.ts   # Entry point
│       │   ├── config.ts  # Zod config schema
│       │   ├── types.ts   # DeepBook constants
│       │   └── ...        # Grid strategy, order management, etc.
│       └── utils/         # Shared utilities
└── external/
    └── deepbook/          # Git submodule - DeepBookV3 source
        ├── packages/      # Move smart contracts
        └── crates/        # Rust crates (indexer, API server)
```

## Docker Stack

Docker compose file: `./sandbox/docker-compose.yml`

Services in the stack:

| Service | Profile | Description | Ports |
|---------|---------|-------------|-------|
| **PostgreSQL** | (always) | Database for the indexer | 5432 |
| **Sui Localnet** | `localnet` | Local Sui blockchain for testing | 9000 (RPC), 9123 (faucet) |
| **DeepBook Indexer** | `remote` | Indexes DeepBook events (testnet/mainnet only) | 9184 (metrics) |
| **DeepBook Server** | `remote` | REST API for querying indexed data | 9008 |

> **Note:** The indexer only supports testnet/mainnet (hardcoded checkpoint URLs). It cannot index a local Sui node.

### Running the Stack

```bash
cd sandbox

# Testnet/Mainnet (full indexer stack)
docker compose --profile remote up -d
docker compose --profile remote down      # Stop services
docker compose --profile remote down -v   # Fresh start (remove volumes)

# Localnet (Sui node only - for Move development)
docker compose --profile localnet up -d
docker compose --profile localnet down

# Stop all services (any profile)
docker compose --profile remote --profile localnet down

# View logs
docker compose logs -f
```

## Development Commands

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

# Run the market maker (requires deploy-all first)
pnpm market-maker

# Stop localnet containers
pnpm down
```

### Market Maker Configuration

Environment variables for `pnpm market-maker`:
- `MM_SPREAD_BPS` - Spread in basis points (default: 10 = 0.1%)
- `MM_LEVELS_PER_SIDE` - Orders per side (default: 5)
- `MM_REBALANCE_INTERVAL_MS` - Rebalance interval (default: 10000)
- `MM_HEALTH_CHECK_PORT` - Health server port (default: 3000)
- `MM_METRICS_PORT` - Prometheus metrics port (default: 9090)

See `sandbox/scripts/market-maker/README.md` for full documentation.

## Key Concepts

- **Balance Manager**: Shared object holding all balances for an account (1 owner, up to 1000 traders)
- **Pool**: Contains Book (order matching), State (user data, volumes, governance), and Vault (settlement)
- **DEEP Token**: Required for trading fees; can be staked for reduced fees and governance participation


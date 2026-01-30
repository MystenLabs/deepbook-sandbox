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
│   └── docker-compose.yml # Docker orchestration (WIP)
└── external/
    └── deepbook/          # Git submodule - DeepBookV3 source
        ├── packages/      # Move smart contracts
        └── crates/        # Rust crates (indexer, API server)
```

## Docker Stack

Docker compose file: `./sandbox/docker-compose.yml`

Services in the stack:

| Service | Description | Default Port |
|---------|-------------|--------------|
| **Sui Localnet** | Local Sui blockchain for testing | 9000 (RPC), 9123 (faucet) |
| **PostgreSQL** | Database for the indexer | 5432 |
| **DeepBook Indexer** | Indexes DeepBook events from chain | 9184 (metrics) |
| **DeepBook API** | REST API for querying indexed data | TBD |

### Running the Stack

```bash
cd sandbox
docker compose up -d        # Start all services
docker compose logs -f      # Follow logs
docker compose down         # Stop all services
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

## Key Concepts

- **Balance Manager**: Shared object holding all balances for an account (1 owner, up to 1000 traders)
- **Pool**: Contains Book (order matching), State (user data, volumes, governance), and Vault (settlement)
- **DEEP Token**: Required for trading fees; can be staked for reduced fees and governance participation


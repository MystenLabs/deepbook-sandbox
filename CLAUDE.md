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

Run `ls`/`find` to explore the tree. Top-level: `sandbox/` (docker-compose stack, `dashboard/`, `api/`, `scripts/`), `examples/sandbox/` (SDK integration examples), and `external/deepbook/` (DeepBookV3 git submodule). Subsystem-specific guidance lives in nested `CLAUDE.md` files (`sandbox/dashboard/`, `sandbox/scripts/oracle-service/`, `sandbox/scripts/market-maker/`).

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
| **DeepBook Faucet**  | `localnet` | Distributes SUI (proxied), DEEP, and USDC tokens   | 9009                          |
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

**CI workflow:** `.github/workflows/integration-tests.yml` runs both test suites in a matrix (parallel runners). Triggers on PRs/pushes that touch `sandbox/` or `external/deepbook/`, plus `workflow_dispatch`. The `sui` CLI is extracted from the pinned `SUI_TOOLS_IMAGE` Docker image to match the localnet container version. On failure, Docker logs are uploaded as artifacts.

**Key pattern — pinned sui-tools image:** `SUI_TOOLS_IMAGE` is pinned to a released tag (`testnet-v1.75.1`) in the CI workflow env, `defaultSuiToolsImage()` in `sandbox/scripts/utils/keygen.ts`, `sandbox/.env.example`, and several docs (docker-compose.yml comments, READMEs). When bumping the pin, `grep -r "sui-tools:"` and update every reference. Never use the moving `compat`/`compat-arm64` tags — they track sui main and have broken CI before (sui 1.76 made the embedded rpc-store index asynchronous, which crash-loops `sui start --with-faucet` at startup; SEDEFI-348). When bumping the pin, verify the faucet comes up: run the image with `sui start --with-faucet --force-regenesis` and curl `http://127.0.0.1:9123/v1/status`.

## Oracle Service

Pyth price-feed updater (Docker, `localnet` profile, status on `http://localhost:9010`). Subsystem details — env vars, price-feed IDs — live in `sandbox/scripts/oracle-service/CLAUDE.md` (loads when you work in that dir); full docs in its `README.md`.

## Market Maker

Automated market maker (Docker, `localnet` profile). Config env vars (`MM_*`) live in `sandbox/scripts/market-maker/CLAUDE.md`; full docs in its `README.md`.

## Key Concepts

- **Balance Manager**: Shared object holding all balances for an account (1 owner, up to 1000 traders).
- **Pool**: Contains Book (order matching), State (user data, volumes, governance), and Vault (settlement).
- **DEEP Token**: Required for trading fees; can be staked for reduced fees and governance participation.

## Trading Page (Dashboard)

Architecture notes for the dashboard's user-facing Trading page — user-driven BM creation, on-chain BM discovery, registry-map init, wallet-swap keying — live in `sandbox/dashboard/CLAUDE.md` (loads when you work under `sandbox/dashboard/`). Read that before touching any trading flow.

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

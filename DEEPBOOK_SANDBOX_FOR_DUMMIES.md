# DeepBook Sandbox for Dummies

A beginner's guide to running your own local DeepBook V3 exchange — a complete blockchain order book with oracle pricing, automated market making, and a web dashboard — all on your laptop.

---

## 1. What Is This?

DeepBook V3 is a decentralized central limit order book (CLOB) built on the Sui blockchain. Think of it as a stock exchange smart contract: buyers and sellers post limit orders, and the contract matches them automatically. Building against it normally requires deploying to a shared testnet, waiting for transactions, and competing with other developers for network resources.

DeepBook Sandbox eliminates that friction. One command starts a private Sui blockchain on your machine, deploys the entire DeepBook protocol (smart contracts, token, oracle feeds, margin trading), creates liquidity pools pre-filled with a market maker, and hands you a working dashboard. You get a complete exchange in Docker containers that resets cleanly every time.

After following this guide, you'll have a running local DeepBook instance with live order books, a faucet for free test tokens, real-time price feeds, and a React dashboard to monitor everything.

## 2. How It All Fits Together

```
                            ┌──────────────────────────┐
                            │     Web Dashboard        │
                            │  (React, localhost:5173) │
                            └────────┬─────────────────┘
                                     │ HTTP (Vite proxy)
       ┌─────────────┬──────────────┼──────────────┬──────────────────┐
       │             │              │              │                  │
┌──────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐ ┌────▼───────┐ ┌────────▼────────┐
│ Sui Localnet│ │ Oracle   │ │  Market    │ │  DeepBook  │ │ DeepBook Server │
│ :9000 RPC   │ │ Service  │ │  Maker     │ │  Faucet    │ │   :9008 REST    │
│ :9123 Faucet│ │  :9010   │ │  :3001     │ │  :9009     │ │   API           │
└──────┬──────┘ └────┬─────┘ └─────┬──────┘ └────┬──────┘ └────────┬────────┘
       │              │              │              │                  │
       │         Pyth prices    place orders   SUI + DEEP        ┌───▼───┐
       │              │              │          distribution      │Postgres│
       │              │              │              │             │ :5432  │
       └──────────────┴──────────────┴──────────────┴─────────────┴───────┘
                              deepbook-net (Docker bridge)

       ┌──────────────┐    reads checkpoints    ┌────────────────┐
       │  Indexer      │◄───────────────────────│  Sui Localnet  │
       │  :9184        │    writes events        │                │
       └──────┬───────┘────────────────────────►│                │
              │                                  └────────────────┘
              ▼
         ┌────────┐
         │Postgres│
         │ :5432  │
         └────────┘
```

The **Sui Localnet** container runs a full Sui blockchain node. The **deploy-all** script publishes all Move smart contracts (token, deepbook, margin, pyth) to this chain, then starts the supporting services. The **Oracle Service** pushes real Pyth Network prices for SUI and DEEP every 10 seconds. The **Market Maker** maintains a grid of buy/sell orders so the pools have liquidity. The **Indexer** reads blockchain checkpoints and writes events into **PostgreSQL**, and the **DeepBook Server** exposes that data as a REST API. The **Faucet** distributes both SUI (proxied) and DEEP tokens for testing.

## 3. Prerequisites

- **Docker Desktop** — install from [docker.com](https://docs.docker.com/get-docker/) (includes `docker compose`). Make sure the Docker daemon is running (whale icon in your menu bar)
- **Node.js 18+** — `brew install node` (or download from nodejs.org)
- **pnpm** — `npm install -g pnpm`
- **Sui CLI** — `brew install sui` (version 1.63.2–1.64.1 recommended; run `sui --version` to verify)
- **(Optional) pre-commit** — `brew install pre-commit` (for git hook management)

## 4. Configuration

For localnet, you only need to set one variable — the Sui container image for your CPU architecture. Copy the example file:

```bash
cd sandbox
cp .env.example .env
```

Then open `.env` and verify this line matches your machine:

```bash
# Apple Silicon (M1/M2/M3/M4):
SUI_TOOLS_IMAGE=mysten/sui-tools:mainnet-v1.63.3-arm64

# Intel/AMD:
# SUI_TOOLS_IMAGE=mysten/sui-tools:mainnet-v1.63.3
```

Everything else (`PRIVATE_KEY`, package IDs, oracle IDs, pool IDs) is auto-generated by `deploy-all`. You never need to fill those in manually for localnet.

See the full [Configuration Reference](#appendix-b-configuration-reference) at the end for all variables.

## 5. First-Time Setup

```bash
# 1. Clone the repo with submodules
git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git
cd deepbook-sandbox

# 2. Install Node.js dependencies
cd sandbox
pnpm install
```

That's it for setup. The heavy lifting (downloading Docker images, deploying contracts) happens in the next step.

## 6. Core Usage — Launching the Sandbox

From the `sandbox/` directory:

```bash
pnpm deploy-all
```

> **Tip:** `pnpm deploy-all --quick` skips building the indexer and server Rust images from source, using pre-built Docker Hub images instead. Much faster for a first run.

Here's what happens behind the scenes:

1. **Docker containers start** — Sui Localnet and PostgreSQL spin up. The Sui node generates a fresh keypair and copies it to `deployments/.sui-keystore`.
2. **Key import** — The script reads the container's keypair, imports it into your host `sui` CLI, and configures a `localnet` environment pointing at `http://127.0.0.1:9000`.
3. **Deployer funded** — The script requests SUI from the built-in faucet so the deployer has gas for publishing.
4. **Move packages deployed** — Five packages are published in order: `token` (the DEEP coin), `deepbook` (the core order book), `deepbook_margin` (margin trading), `pyth` (oracle contracts), and supporting modules.
5. **Indexer + server + faucet start** — The indexer and server images are built from source (this compiles Rust, so it takes a few minutes the first time). Then the indexer starts reading checkpoints from the Sui node, the REST server comes online on port 9008, and the faucet service starts on port 9009.
6. **Pyth oracles created** — Price feed objects for SUI, DEEP, and USDC are created on-chain. A dedicated oracle keypair is generated and funded (separate from the deployer to avoid gas coin conflicts).
7. **Oracle service starts** — Begins pushing real Pyth Network prices every 10 seconds.
8. **Pools created** — A DEEP/SUI pool and a SUI/USDC pool are created, along with SUI and USDC margin pools.
9. **Market maker starts** — Places a grid of buy/sell orders around the oracle mid-price, rebalancing every 10 seconds.
10. **Deployment manifest written** — All IDs are saved to `sandbox/deployments/localnet.json` and `sandbox/.env`.

When you see `DeepBook Sandbox Ready!`, everything is running:

| Endpoint                     | URL                           |
| ---------------------------- | ----------------------------- |
| Sui RPC                      | http://localhost:9000         |
| Sui Faucet (native)          | http://localhost:9123         |
| DeepBook Faucet (SUI + DEEP) | http://localhost:9009         |
| DeepBook REST API            | http://localhost:9008         |
| Oracle Status                | http://localhost:9010         |
| Market Maker Health          | http://localhost:3001/health  |
| Market Maker Metrics         | http://localhost:9091/metrics |
| Indexer Metrics              | http://localhost:9184/metrics |

## 7. Launching the Dashboard

The web dashboard is a separate React app (not part of the Docker stack):

```bash
cd sandbox/dashboard
pnpm install
pnpm dev
```

Open http://localhost:5173. The dashboard has four pages:

- **Health** — Real-time status of all services (Sui node, indexer, oracle, market maker, faucet), auto-refreshes every 10 seconds
- **Market Maker** — Order book bar chart, active bid/ask levels, and grid configuration
- **Faucet** — Connect a Sui wallet and request SUI or DEEP tokens
- **Deployment** — Browse deployed package IDs, pool addresses, and Pyth oracle objects with explorer links

The Vite dev server proxies API requests to the sandbox services:

| Path            | Target           | Service          |
| --------------- | ---------------- | ---------------- |
| `/api/sui`      | `localhost:9000` | Sui localnet RPC |
| `/api/oracle`   | `localhost:9010` | Oracle service   |
| `/api/mm`       | `localhost:3001` | Market maker     |
| `/api/faucet`   | `localhost:9009` | Faucet           |
| `/api/deepbook` | `localhost:9008` | DeepBook server  |

## 8. Day-to-Day Workflow

```bash
cd sandbox

# Start fresh (first time or after teardown)
pnpm deploy-all

# Check that prices are updating
curl http://localhost:9010/

# Request DEEP tokens for your test address
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x<your-address>","token":"DEEP","amount":500}'

# Request SUI tokens
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x<your-address>","token":"SUI"}'

# Query the chain directly (your sui CLI is already configured)
sui client gas

# View market maker activity
docker compose logs -f market-maker

# View oracle updates
docker compose logs -f oracle-service

# Check all containers
docker compose ps

# Done for the day — full cleanup
pnpm down
```

## 9. Using the Faucet

The faucet service on port 9009 distributes both SUI and DEEP tokens. It's separate from the native Sui faucet (port 9123) because DEEP tokens require a signed transfer from the deployer's TreasuryCap.

**Request DEEP tokens** (default: 1000 DEEP, max: 10000 per request):

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x1234...","token":"DEEP","amount":1000}'
```

**Request SUI tokens** (proxied to the native Sui faucet):

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x1234...","token":"SUI"}'
```

**Check faucet info:**

```bash
curl http://localhost:9009/
```

**Get the deployment manifest** (all package IDs, pool IDs, oracle objects):

```bash
curl http://localhost:9009/manifest
```

## 10. Rebuilding / Destructive Operations

**Full teardown** — stops all containers, removes volumes, and cleans auto-generated keys:

```bash
cd sandbox
pnpm down
```

| What                                                            | Destroyed?                    |
| --------------------------------------------------------------- | ----------------------------- |
| Docker containers                                               | Yes — all stopped and removed |
| Docker volumes (chain data, postgres)                           | Yes — wiped clean             |
| Auto-generated .env keys (package IDs, oracle IDs, pool IDs)    | Yes — cleaned                 |
| User-set .env values (NETWORK, SUI*TOOLS_IMAGE, MM*\* settings) | No — preserved                |
| Deployment manifest (deployments/localnet.json)                 | No — kept for reference       |
| Your source code                                                | Never                         |
| Dashboard code/config                                           | Never                         |

> **Note:** By default, `FORCE_REGENESIS=true` means the Sui node wipes chain state on every restart. Set it to empty in `.env` if you want data to persist across `deploy-all` runs.

**Re-deploy without teardown** — just run `pnpm deploy-all` again. It will overwrite `.env` with new package IDs and force-recreate containers.

**Always save any important addresses or object IDs before running `pnpm down` — the chain state is destroyed.**

## 11. Working with DeepBook Move Code

The DeepBook V3 smart contracts live in a git submodule at `external/deepbook/`:

```bash
# Initialize submodule (if you didn't clone with --recurse-submodules)
git submodule update --init --recursive

# Build the Move package
cd external/deepbook/packages/deepbook
sui move build

# Run tests
sui move test
sui move test --skip-fetch-latest-git-deps  # faster if deps haven't changed

# Format Move files
bunx prettier-move -c *.move --write
```

## 12. Troubleshooting

**"Set SUI_TOOLS_IMAGE in .env"** — You forgot to copy `.env.example` to `.env`, or the `SUI_TOOLS_IMAGE` line is empty. Run `cp .env.example .env` from the `sandbox/` directory.

**"Timed out waiting for deployments/.sui-keystore"** — The Sui container crashed before generating its key. Check `docker logs sui-localnet` for the error. Common cause: wrong `SUI_TOOLS_IMAGE` for your CPU architecture (arm64 vs x86_64).

**"Failed to connect to Sui RPC"** — Docker is not running, or the Sui container hasn't started yet. Run `docker ps` to check.

**"Transaction failed" in oracle service** — The oracle's dedicated keypair ran out of SUI. This shouldn't happen since `deploy-all` funds it automatically. If it does, check `docker logs oracle-service` and re-run `pnpm deploy-all`.

**Deploy takes a long time building Rust images** — The indexer and server are Rust services compiled from source. This is normal on first run (several minutes). Docker caches the build layers, so subsequent runs are faster.

**Port conflicts** — Another process is using port 9000, 5432, or 9123. Stop the conflicting process or change ports in `docker-compose.yml`.

**Dashboard can't connect** — Make sure the sandbox is running (`docker compose ps`). The dashboard proxies requests to `localhost:9000` (RPC), `localhost:9009` (faucet), `localhost:9010` (oracle), `localhost:3001` (market maker), and `localhost:9008` (server).

---

## Appendix A: All Commands

| Command                                     | Description                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm deploy-all`                           | Deploy everything — start containers, publish contracts, create pools, start services |
| `pnpm down`                                 | Full teardown — stop containers, remove volumes, clean generated .env keys            |
| `pnpm oracle-service`                       | Run the oracle service locally (outside Docker, for debugging)                        |
| `pnpm market-maker`                         | Run the market maker locally (outside Docker, for debugging)                          |
| `pnpm test:integration`                     | Run all integration tests                                                             |
| `pnpm test:integration <pattern>`           | Run a specific integration test by filename pattern                                   |
| `docker compose logs -f`                    | Follow logs from all containers                                                       |
| `docker compose logs -f <service>`          | Follow logs from a specific service                                                   |
| `docker compose ps`                         | List running containers and their status                                              |
| `docker compose --profile localnet down`    | Stop all localnet containers                                                          |
| `docker compose --profile localnet down -v` | Stop containers and remove volumes                                                    |
| `docker compose --profile remote up -d`     | Start the remote profile (testnet/mainnet indexer stack)                              |
| `curl http://localhost:9010/`               | Check oracle service status and latest prices                                         |
| `curl http://localhost:3001/health`         | Check market maker health                                                             |
| `curl http://localhost:9091/metrics`        | View market maker Prometheus metrics                                                  |
| `curl http://localhost:9009/manifest`       | View full deployment manifest (package IDs, pools, oracles)                           |

## Appendix B: Configuration Reference

All variables from `sandbox/.env.example`:

| Variable                    | Required                        | Default                                            | Description                                                               |
| --------------------------- | ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `SUI_TOOLS_IMAGE`           | Yes (localnet)                  | —                                                  | Docker image for Sui node; set based on CPU arch                          |
| `PRIVATE_KEY`               | No (auto-generated on localnet) | —                                                  | Deployer/signer private key (`suiprivkey1...` or `0x...` hex)             |
| `ORACLE_PRIVATE_KEY`        | No (auto-generated)             | —                                                  | Dedicated oracle service keypair                                          |
| `NETWORK`                   | No                              | `localnet`                                         | Target network: `localnet` or `testnet`                                   |
| `RPC_URL`                   | No                              | auto-detected                                      | Sui RPC endpoint override                                                 |
| `FORCE_REGENESIS`           | No                              | `true`                                             | Wipe chain state on restart; set empty to persist                         |
| `DEEPBOOK_PACKAGE_ID`       | No (auto-populated)             | —                                                  | Deployed DeepBook package address                                         |
| `DEEP_TOKEN_PACKAGE_ID`     | No (auto-populated)             | —                                                  | DEEP token package address                                                |
| `DEEP_TREASURY_ID`          | No (auto-populated)             | —                                                  | DEEP TreasuryCap object ID                                                |
| `MARGIN_PACKAGE_ID`         | No (auto-populated)             | —                                                  | Margin trading package address                                            |
| `PYTH_PACKAGE_ID`           | No (auto-populated)             | —                                                  | Pyth oracle package address                                               |
| `POOL_ID`                   | No (auto-populated)             | —                                                  | DEEP/SUI pool object ID                                                   |
| `BASE_COIN_TYPE`            | No (auto-populated)             | —                                                  | Base coin type for the pool                                               |
| `DEPLOYER_ADDRESS`          | No (auto-populated)             | —                                                  | Deployer's Sui address                                                    |
| `DEEP_PRICE_INFO_OBJECT_ID` | No (auto-populated)             | —                                                  | DEEP PriceInfoObject ID                                                   |
| `SUI_PRICE_INFO_OBJECT_ID`  | No (auto-populated)             | —                                                  | SUI PriceInfoObject ID                                                    |
| `USDC_PRICE_INFO_OBJECT_ID` | No (auto-populated)             | —                                                  | USDC PriceInfoObject ID                                                   |
| `FIRST_CHECKPOINT`          | No                              | —                                                  | Starting checkpoint for the indexer                                       |
| `RUST_LOG`                  | No                              | `info`                                             | Log level for Rust services: trace, debug, info, warn, error              |
| `MM_POOLS`                  | No (auto-populated)             | —                                                  | JSON array of per-pool configs (pool IDs, coin types, sizes, oracle refs) |
| `MM_SPREAD_BPS`             | No                              | `10`                                               | Market maker spread in basis points (10 = 0.1%)                           |
| `MM_LEVELS_PER_SIDE`        | No                              | `5`                                                | Number of orders per side                                                 |
| `MM_LEVEL_SPACING_BPS`      | No                              | `5`                                                | Spacing between order price levels in bps (5 = 0.05%)                     |
| `MM_REBALANCE_INTERVAL_MS`  | No                              | `10000`                                            | Rebalance interval in milliseconds                                        |
| `MM_HEALTH_CHECK_PORT`      | No                              | `3000`                                             | Health check port inside container (mapped to host 3001)                  |
| `MM_METRICS_PORT`           | No                              | `9090`                                             | Prometheus metrics port inside container (mapped to host 9091)            |
| `MARKET_MAKER_IMAGE`        | No                              | `mysten/deepbook-sandbox-market-maker:...-arm64`   | Market maker Docker image override                                        |
| `INDEXER_IMAGE`             | No                              | `mysten/deepbookv3-sandbox-indexer:...-arm64`      | Indexer Docker image override                                             |
| `SERVER_IMAGE`              | No                              | `mysten/deepbookv3-server:...-arm64`               | DeepBook server Docker image override                                     |
| `FAUCET_IMAGE`              | No                              | `mysten/deepbook-sandbox-faucet:...-arm64`         | Faucet Docker image override                                              |
| `ORACLE_SERVICE_IMAGE`      | No                              | `mysten/deepbook-sandbox-oracle-service:...-arm64` | Oracle service Docker image override                                      |

## Appendix C: How It Boots (Under the Hood)

When you run `pnpm deploy-all`, here's the full sequence:

1. **Env bootstrap** — If `PRIVATE_KEY` is missing, a placeholder keypair is generated so `docker-compose.yml` can parse its `${PRIVATE_KEY:?...}` variable validation. If `SUI_TOOLS_IMAGE` is missing, it's auto-detected based on CPU architecture (`arm64` vs `x86_64`).
2. **Docker compose up (localnet profile)** — Starts `sui-localnet` and `postgres` containers only. The Sui container runs `sui client new-address ed25519`, copies the keystore to a shared volume (`deployments/.sui-keystore`), and launches the node with `--force-regenesis` and `--with-faucet`.
3. **RPC polling** — The script polls `http://127.0.0.1:9000` until the node responds, then polls the faucet at port 9123.
4. **Key import** — Reads the last entry from the container's keystore file, reconstructs the Ed25519 keypair, imports it into the host `sui` CLI with `sui keytool import`, creates a `localnet` environment, and switches to it.
5. **Faucet funding** — Requests SUI from the built-in faucet to fund the deployer address for gas.
6. **Move deployment** — Publishes five packages in dependency order. Each `sui client publish` transaction creates objects (TreasuryCap, package ID, etc.) that are parsed and stored.
7. **Env file update** — All package IDs, object IDs, and `FIRST_CHECKPOINT=0` are written to `sandbox/.env`.
8. **Indexer + server + faucet start** — Builds the indexer and server images from source (`--build`), then starts `deepbook-indexer`, `deepbook-server`, and `deepbook-faucet` containers with `--force-recreate` so they pick up the new env vars.
9. **Pyth oracle setup** — Creates PriceInfoObjects on-chain for SUI, DEEP, and USDC. Generates a separate Ed25519 keypair for the oracle service, funds it via faucet, and saves `ORACLE_PRIVATE_KEY` to `.env`.
10. **Oracle service start** — Starts the `oracle-service` container, which immediately begins fetching 24-hour-old prices from `benchmarks.pyth.network` and submitting update transactions every 10 seconds.
11. **Pool creation** — Creates a DEEP/SUI pool and a SUI/USDC pool on-chain via the DeepBook contract. Also creates SUI and USDC margin pools. Pool IDs are written to `.env`.
12. **Market maker start** — Starts the `market-maker` container. It creates a BalanceManager, funds it with DEEP and SUI, and begins placing a grid of POST_ONLY limit orders around the oracle mid-price.
13. **Manifest written** — A JSON deployment manifest with all addresses, pool IDs, and oracle IDs is saved to `sandbox/deployments/localnet.json`.

## Appendix D: Docker Services Reference

| Service            | Container Name          | Profile              | Ports (host:container) | Description                                     |
| ------------------ | ----------------------- | -------------------- | ---------------------- | ----------------------------------------------- |
| `postgres`         | `deepbook-postgres`     | (always)             | 5432:5432              | PostgreSQL 16 database for the indexer          |
| `sui-localnet`     | `sui-localnet`          | `localnet`           | 9000:9000, 9123:9123   | Full Sui node with built-in faucet              |
| `market-maker`     | `deepbook-market-maker` | `localnet`           | 3001:3000, 9091:9090   | Grid market maker for DEEP/SUI + SUI/USDC pools |
| `deepbook-indexer` | `deepbook-indexer`      | `remote`, `localnet` | 9184:9184              | Reads checkpoints, writes events to Postgres    |
| `deepbook-server`  | `deepbook-server`       | `remote`, `localnet` | 9008:9008, 9185:9184   | REST API for querying indexed DeepBook data     |
| `deepbook-faucet`  | `deepbook-faucet`       | `localnet`, `remote` | 9009:9009              | Distributes SUI (proxied) and DEEP tokens       |
| `oracle-service`   | `oracle-service`        | `localnet`           | 9010:9010              | Updates Pyth price feeds every 10 seconds       |

## Appendix E: How Data Flows

**Price flow:** Pyth Network API -> Oracle Service -> On-chain PriceInfoObjects -> Market Maker (reads mid-price) -> DeepBook Pool (places orders)

**Token flow (faucet):** User request -> Faucet service (:9009) -> SUI: proxied to Sui's built-in faucet (:9123) | DEEP: signed transfer from deployer's TreasuryCap

**Indexing flow:** Sui Localnet (checkpoints) -> Indexer (reads checkpoint volume) -> PostgreSQL -> DeepBook Server (:9008, REST API)

**Market maker cycle (every 10 seconds):**

1. Read latest mid-price from on-chain Pyth oracle
2. Cancel all existing orders
3. Calculate N price levels above and below mid-price (spaced by `MM_LEVEL_SPACING_BPS`)
4. Place POST_ONLY limit orders at each level
5. Wait for rebalance interval, repeat

## Appendix F: Glossary

**Balance Manager** — A shared on-chain object that holds all token balances for a DeepBook account. One owner, up to 1000 authorized traders.

**CLOB (Central Limit Order Book)** — A trading system where buyers and sellers post limit orders at specific prices, and the system matches them. DeepBook is a CLOB implemented as a Sui smart contract.

**DEEP Token** — The native utility token for DeepBook. Required for trading fees. Can be staked for reduced fees and governance voting.

**Grid Strategy** — The market maker's approach: place N buy orders below the mid-price and N sell orders above it, evenly spaced, then cancel and re-place them every rebalance interval.

**Move** — The smart contract programming language used by Sui. DeepBook's core logic is written in Move.

**Pool** — A DeepBook trading venue for a specific token pair (e.g., DEEP/SUI). Contains a Book (order matching engine), State (user data, volumes, governance), and Vault (settlement).

**POST_ONLY** — An order restriction that ensures the order is a maker order (adds liquidity). If it would immediately match, it's rejected instead. The market maker uses this exclusively.

**Pyth Network** — A decentralized oracle network that provides real-time price data. The oracle service fetches SUI and DEEP prices from Pyth and publishes them on-chain.

**PriceInfoObject** — A Sui on-chain object created by the Pyth oracle contract that stores the latest price for a specific asset.

## Appendix G: Important Files

| File                                      | Description                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `sandbox/docker-compose.yml`              | Defines all Docker services, profiles, ports, and volumes                               |
| `sandbox/package.json`                    | npm scripts: `deploy-all`, `down`, `oracle-service`, `market-maker`, `test:integration` |
| `sandbox/.env.example`                    | Template for all environment variables with documentation                               |
| `sandbox/.env`                            | Generated config — package IDs, keys, settings (git-ignored)                            |
| `sandbox/scripts/deploy-all.ts`           | Main deployment orchestrator (6-phase pipeline)                                         |
| `sandbox/scripts/down.ts`                 | Teardown script — stops containers, cleans env                                          |
| `sandbox/scripts/utils/config.ts`         | Env validation with Zod, Sui client/signer factories                                    |
| `sandbox/scripts/utils/docker-compose.ts` | Docker compose helpers (start, stop, wait for health)                                   |
| `sandbox/scripts/utils/keygen.ts`         | Container key reading and host CLI import                                               |
| `sandbox/scripts/utils/deployer.ts`       | Move package deployment logic                                                           |
| `sandbox/scripts/utils/pool.ts`           | Pool creation logic                                                                     |
| `sandbox/scripts/utils/oracle.ts`         | Pyth oracle setup (PriceInfoObject creation)                                            |
| `sandbox/scripts/oracle-service/index.ts` | Oracle service entry point — fetches Pyth prices, submits update txs                    |
| `sandbox/scripts/market-maker/index.ts`   | Market maker entry point — grid strategy, order placement                               |
| `sandbox/faucet/src/index.ts`             | Faucet HTTP server (Hono)                                                               |
| `sandbox/faucet/src/routes/faucet.ts`     | POST /faucet endpoint — validates requests, dispatches SUI or DEEP                      |
| `sandbox/dashboard/src/App.tsx`           | Dashboard React app — Health, Market Maker, Faucet, Deployment pages                    |
| `sandbox/deployments/localnet.json`       | Generated deployment manifest with all addresses and IDs                                |
| `external/deepbook/`                      | Git submodule — DeepBook V3 Move smart contracts and Rust crates                        |

## Appendix H: Submodule Note

DeepBook V3 source code is included as a git submodule at `external/deepbook/`, pointing to `https://github.com/MystenLabs/deepbookv3`. If you cloned without `--recurse-submodules`, initialize it with:

```bash
git submodule update --init --recursive
```

To update to the latest DeepBook code:

```bash
cd external/deepbook
git pull origin main
cd ../..
git add external/deepbook
git commit -m "Update deepbook submodule"
```

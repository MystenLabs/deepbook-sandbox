# DeepBook Sandbox

A one-command local development environment for DeepBook V3 — the decentralized order book on Sui.

---

## 1. What Is This?

DeepBook V3 is a decentralized central limit order book (CLOB) built on the Sui blockchain. Think of it as a stock exchange smart contract: buyers and sellers post limit orders, and the contract matches them automatically. Building against it normally requires deploying to a shared testnet, waiting for transactions, and competing with other developers for network resources.

DeepBook Sandbox eliminates that friction. One command starts a private Sui blockchain on your machine, deploys the entire DeepBook protocol (smart contracts, token, oracle feeds, margin trading), creates liquidity pools pre-filled with a market maker, and hands you a working dashboard. You get a complete exchange in Docker containers that resets cleanly every time.

After following this guide you'll have a running local DeepBook instance with live order books, a faucet for free test tokens, real-time price feeds, and a React dashboard to monitor everything.

## 2. How It All Fits Together

```
                            +----------------------------+
                            |     Web Dashboard          |
                            |  (React, localhost:5173)   |
                            +------------+---------------+
                                         | HTTP (Vite proxy)
       +---------------+-----------+-----+--------+-----------------+
       |               |           |              |                 |
+------v------+ +------v-----+ +--v--------+ +---v----------+ +---v--------------+
| Sui Localnet| | Oracle     | |  Market   | |  DeepBook    | | DeepBook Server  |
| :9000 RPC   | | Service    | |  Maker    | |  Faucet      | |   :9008 REST     |
| :9123 Faucet| |  :9010     | |  :3001    | |  :9009       | |   API            |
+------+------+ +------+-----+ +--+--------+ +---+----------+ +---+--------------+
       |               |           |              |                 |
       |          Pyth prices  place orders   SUI + DEEP        +--v----+
       |               |           |          distribution      |Postgres|
       |               |           |              |             | :5432  |
       +---------------+-----------+--------------+-------------+-------+
                              deepbook-net (Docker bridge)

       +--------------+    reads checkpoints    +----------------+
       |  Indexer      |<-----------------------|  Sui Localnet  |
       |  :9184        |    writes events        |                |
       +---------+-----+----------------------->|                |
                 |                               +----------------+
                 v
            +--------+
            |Postgres|
            | :5432  |
            +--------+
```

The **Sui Localnet** container runs a full Sui blockchain node. The **deploy-all** script publishes all Move smart contracts (token, deepbook, margin, pyth, usdc) to this chain, then starts the supporting services. The **Oracle Service** pushes real Pyth Network prices for SUI and DEEP every 10 seconds. The **Market Maker** maintains a grid of buy/sell orders so the pools have liquidity. The **Indexer** reads blockchain checkpoints and writes events into **PostgreSQL**, and the **DeepBook Server** exposes that data as a REST API. The **Faucet** distributes both SUI (proxied to the native Sui faucet) and DEEP tokens (signed transfers from the deployer).

## 3. Prerequisites

- **Docker Desktop** — install from [docker.com](https://docs.docker.com/get-docker/) (includes `docker compose`). Make sure the Docker daemon is running (whale icon in your menu bar)
- **Node.js 18+** — `brew install node` (or download from [nodejs.org](https://nodejs.org/))
- **pnpm** — `npm install -g pnpm`
- **Sui CLI** — `brew install sui` (version 1.63.2-1.64.1 recommended; run `sui --version` to verify)
- **(Optional) pre-commit** — `brew install pre-commit` (for git hook management)

## 4. Quickstart

```bash
# Clone the repo with submodules (required — DeepBook source is a submodule)
git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git
cd deepbook-sandbox/sandbox

# Install dependencies
pnpm install

# Deploy everything (auto-detects your CPU architecture, no .env setup needed)
pnpm deploy-all
```

> **First run takes several minutes.** Docker images need to be downloaded and the indexer/server Rust binaries compile from source. Subsequent runs are faster thanks to Docker layer caching.
>
> **Intel/AMD shortcut:** `pnpm deploy-all --quick` skips building the Rust images from source and uses pre-built Docker Hub images instead. Apple Silicon users must build from source (Docker Hub only publishes `linux/amd64` images for these services).

When you see `DeepBook Sandbox Ready!`, everything is running:

| Endpoint                     | URL                          |
| ---------------------------- | ---------------------------- |
| Sui RPC                      | http://localhost:9000        |
| Sui Faucet (native)          | http://localhost:9123        |
| DeepBook Faucet (SUI + DEEP) | http://localhost:9009        |
| DeepBook REST API            | http://localhost:9008        |
| Oracle Status                | http://localhost:9010        |
| Market Maker Health          | http://localhost:3001/health |

Verify it works:

```bash
# Check oracle prices are updating
curl http://localhost:9010/

# Check market maker has active orders
curl http://localhost:3001/health

# Check all containers are healthy
docker compose ps
```

**Launch the dashboard** (optional):

```bash
cd sandbox/dashboard
pnpm install
pnpm dev
```

Open http://localhost:5173 to monitor service health, view the order book, request faucet tokens, and browse deployment addresses.

**Tear it all down** when you're done:

```bash
cd sandbox
pnpm down
```

## 5. What deploy-all Does (Under the Hood)

When you run `pnpm deploy-all`, here's the full sequence:

1. **Env bootstrap** — If `SUI_TOOLS_IMAGE` is missing, it's auto-detected based on CPU architecture (`mysten/sui-tools:compat-arm64` for Apple Silicon, `mysten/sui-tools:compat` for Intel/AMD). If `PRIVATE_KEY` is missing, a placeholder keypair is generated so `docker-compose.yml` can parse its variable validation.
2. **Docker compose up** — Starts `sui-localnet` and `postgres` containers. The Sui container generates a fresh Ed25519 keypair, copies the keystore to `deployments/.sui-keystore`, and launches the node with `--force-regenesis` and `--with-faucet`.
3. **RPC polling** — The script polls `http://127.0.0.1:9000` every 2 seconds until the node responds (up to 60 attempts), then polls the faucet at port 9123.
4. **Key import** — Reads the container's keypair from the shared keystore file, imports it into your host `sui` CLI with `sui keytool import`, creates a `localnet` environment pointing at `http://127.0.0.1:9000`, and switches to it.
5. **Faucet funding** — Requests SUI from the built-in faucet so the deployer has gas for publishing.
6. **Move deployment** — Publishes six packages in dependency order: `token` (the DEEP coin), `deepbook` (the core order book), `pyth` (oracle contracts), `usdc` (stablecoin type), `deepbook_margin` (margin trading), and `margin_liquidation`. Each uses `sui client test-publish --build-env localnet`.
7. **Env file update** — All package IDs, object IDs, and `FIRST_CHECKPOINT=0` are written to `sandbox/.env`.
8. **Indexer + server + faucet start** — The indexer and server images are built from source (Rust compilation — takes a few minutes the first time). Then `deepbook-indexer`, `deepbook-server`, and `deepbook-faucet` containers start with `--force-recreate` so they pick up the new env vars. With `--quick`, the Rust build is skipped and pre-built Docker Hub images are used instead.
9. **Pyth oracle setup** — Creates PriceInfoObjects on-chain for SUI ($1.00), DEEP ($0.02), and USDC ($1.00). Generates a separate Ed25519 keypair for the oracle service (separate from the deployer to avoid gas coin conflicts), funds it via faucet, and saves `ORACLE_PRIVATE_KEY` to `.env`.
10. **Oracle service start** — Starts the `oracle-service` container, which begins fetching 24-hour-old historical prices from `benchmarks.pyth.network` and submitting update transactions every 10 seconds.
11. **Pool creation** — Creates a DEEP/SUI pool and a SUI/USDC pool on-chain via the DeepBook contract. Also creates SUI and USDC margin pools and registers the SUI/USDC pool for margin trading.
12. **Market maker start** — Starts the `market-maker` container. It creates a BalanceManager (shared on-chain object), deposits DEEP, SUI, and USDC into it, and begins placing a grid of POST_ONLY limit orders around the oracle mid-price, rebalancing every 10 seconds.
13. **Manifest written** — A JSON deployment manifest with all addresses, pool IDs, and oracle IDs is saved to `sandbox/deployments/localnet.json` and `sandbox/.env`. The Sui CLI also writes `sandbox/Pub.localnet.toml` which tracks published package addresses for dependency resolution.

## 6. The Dashboard

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

## 7. Building Your Own Contracts on DeepBook

The sandbox includes an `example_contract` template for writing Move contracts that depend on DeepBook. After `pnpm deploy-all`, all DeepBook packages are published on your local chain and their addresses are tracked in `sandbox/Pub.localnet.toml`.

### Create your contract

Copy the template and start editing:

```bash
cp -r sandbox/packages/example_contract sandbox/packages/my_contract
```

Your `Move.toml` can reference any of these local dependencies:

| Dependency           | Path                                          | Description                                            |
| -------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `token`              | `../../.external-packages/token`              | DEEP token definition                                  |
| `deepbook`           | `../../.external-packages/deepbook`           | Core DeepBook package (pools, orders, balance manager) |
| `deepbook_margin`    | `../../.external-packages/deepbook_margin`    | Margin trading extension                               |
| `margin_liquidation` | `../../.external-packages/margin_liquidation` | Margin liquidation logic                               |
| `pyth`               | `../pyth`                                     | Pyth oracle price feeds                                |
| `usdc`               | `../usdc`                                     | USDC coin type                                         |

> **Note:** The `.external-packages/` directory is created automatically by `pnpm deploy-all`. Your contract won't build until you've run it at least once.

Your `Move.toml` needs an `[environments]` section with the localnet chain ID (you can find the value in `Pub.localnet.toml` after deploying):

```toml
[package]
name = "my_contract"
edition = "2024"

[dependencies]
deepbook = { local = "../../.external-packages/deepbook" }
token = { local = "../../.external-packages/token" }

[environments]
localnet = "<chain-id>"   # copy from Pub.localnet.toml
```

### Publish your contract

```bash
cd sandbox/packages/my_contract
sui client test-publish --build-env localnet --pubfile-path ../../Pub.localnet.toml
```

The `--pubfile-path` flag tells the Sui CLI where to find the already-published DeepBook packages so it can resolve your dependencies against the live localnet deployment. The `--build-env localnet` flag selects the chain ID from your `[environments]` section.

### Tips

- **Iterate without re-deploying**: You only need to run `pnpm deploy-all` once. After that, re-publish your custom contract as many times as you need — the `Pub.localnet.toml` accumulates your published packages too.
- **Build without publishing**: Run `sui move build --build-env localnet` from your contract directory to check compilation.
- **Fresh start**: Run `pnpm down` to tear down everything, then `pnpm deploy-all` again. You'll need to re-publish your custom contract since the chain state is wiped.

## 8. Using the Faucet

The faucet service on port 9009 distributes both SUI and DEEP tokens. It's separate from the native Sui faucet (port 9123) because DEEP tokens require a signed transfer from the deployer's TreasuryCap.

**Request DEEP tokens** (default: 1000 DEEP, max: 10000 per request):

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x<your-address>","token":"DEEP","amount":1000}'
```

**Request SUI tokens** (proxied to the native Sui faucet):

```bash
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x<your-address>","token":"SUI"}'
```

**Check faucet info:**

```bash
curl http://localhost:9009/
```

**Get the deployment manifest** (all package IDs, pool IDs, oracle objects):

```bash
curl http://localhost:9009/manifest
```

You can also request tokens from the dashboard's Faucet tab at http://localhost:5173 (requires a connected Sui wallet).

## 9. Day-to-Day Workflow

```bash
cd sandbox

# Start fresh (first time or after teardown)
pnpm deploy-all              # builds indexer/server from source
pnpm deploy-all --quick      # uses pre-built images (Intel/AMD only)

# Check that prices are updating
curl http://localhost:9010/

# Request tokens for your test address
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0x<your-address>","token":"DEEP","amount":500}'

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

## 10. Teardown & Reset

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
| Pub.localnet.toml                                               | Yes — removed                 |
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

**"Set SUI_TOOLS_IMAGE in .env"** — You forgot to copy `.env.example` to `.env`, or the `SUI_TOOLS_IMAGE` line is empty. For localnet, `deploy-all` auto-detects this, so this usually means you're running Docker compose directly instead of using `pnpm deploy-all`. Run `cp .env.example .env` from the `sandbox/` directory, or just use `pnpm deploy-all`.

**"Timed out waiting for deployments/.sui-keystore"** — The Sui container crashed before generating its key. Check `docker logs sui-localnet` for the error. Common cause: wrong `SUI_TOOLS_IMAGE` for your CPU architecture (arm64 vs x86_64).

**"Failed to connect to Sui RPC"** — Docker is not running, or the Sui container hasn't started yet. Run `docker ps` to check.

**"Transaction failed" in oracle service** — The oracle's dedicated keypair ran out of SUI. This shouldn't happen since `deploy-all` funds it automatically. If it does, check `docker logs oracle-service` and re-run `pnpm deploy-all`.

**Deploy takes a long time building Rust images** — The indexer and server are Rust services that compile from source by default. This is normal on first run (can take several minutes). On Intel/AMD machines, you can skip the build with `pnpm deploy-all --quick`. Apple Silicon users must build from source since Docker Hub only publishes `linux/amd64` images for these services.

**Port conflicts** — Another process is using port 9000, 5432, or 9123. Stop the conflicting process or change ports in `docker-compose.yml`.

**Dashboard can't connect** — Make sure the sandbox is running (`docker compose ps`). The dashboard proxies requests to `localhost:9000` (RPC), `localhost:9009` (faucet), `localhost:9010` (oracle), `localhost:3001` (market maker), and `localhost:9008` (server).

**Contract won't build: "unresolved dependency"** — You haven't run `pnpm deploy-all` yet. The `.external-packages/` directory (which your `Move.toml` references) is created by the deploy script. Run `pnpm deploy-all` first, then build your contract.

---

## Appendix A: All Commands

| Command                                     | Description                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm deploy-all`                           | Deploy everything — start containers, publish contracts, create pools, start services |
| `pnpm deploy-all --quick`                   | Same as above but skip building indexer/server images (uses Docker Hub, amd64 only)   |
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

All variables from `sandbox/.env.example`. For localnet, you don't need to set any of these — `deploy-all` auto-detects and auto-generates everything.

| Variable                    | Required                        | Default                                            | Description                                                               |
| --------------------------- | ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `SUI_TOOLS_IMAGE`           | No (auto-detected)              | `mysten/sui-tools:compat[-arm64]`                  | Docker image for Sui node; auto-detected from CPU architecture            |
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

## Appendix C: Docker Services Reference

| Service            | Container Name          | Profile              | Ports (host:container) | Description                                     |
| ------------------ | ----------------------- | -------------------- | ---------------------- | ----------------------------------------------- |
| `postgres`         | `deepbook-postgres`     | (always)             | 5432:5432              | PostgreSQL 16 database for the indexer          |
| `sui-localnet`     | `sui-localnet`          | `localnet`           | 9000:9000, 9123:9123   | Full Sui node with built-in faucet              |
| `market-maker`     | `deepbook-market-maker` | `localnet`           | 3001:3000, 9091:9090   | Grid market maker for DEEP/SUI + SUI/USDC pools |
| `deepbook-indexer` | `deepbook-indexer`      | `remote`, `localnet` | 9184:9184              | Reads checkpoints, writes events to Postgres    |
| `deepbook-server`  | `deepbook-server`       | `remote`, `localnet` | 9008:9008, 9185:9184   | REST API for querying indexed DeepBook data     |
| `deepbook-faucet`  | `deepbook-faucet`       | `localnet`, `remote` | 9009:9009              | Distributes SUI (proxied) and DEEP tokens       |
| `oracle-service`   | `oracle-service`        | `localnet`           | 9010:9010              | Updates Pyth price feeds every 10 seconds       |

## Appendix D: Data Flows

**Price flow:** Pyth Network API (`benchmarks.pyth.network`) -> Oracle Service -> on-chain PriceInfoObjects -> Market Maker (reads mid-price) -> DeepBook Pool (places orders at grid levels)

**Token flow (faucet):** User request -> Faucet service (:9009) -> SUI: proxied to Sui's built-in faucet (:9123) | DEEP: signed transfer from deployer's TreasuryCap

**Indexing flow:** Sui Localnet (checkpoints written to shared volume) -> Indexer (reads checkpoint files) -> PostgreSQL (:5432) -> DeepBook Server (:9008, REST API)

**Market maker cycle (every 10 seconds):**

1. Read latest mid-price from on-chain Pyth oracle
2. Fall back to last-known or hardcoded price if oracle is unavailable
3. Cancel all existing orders
4. Calculate N price levels above and below mid-price (spaced by `MM_LEVEL_SPACING_BPS`)
5. Place POST_ONLY limit orders at each level (maker-only, no taker fees)
6. Wait for rebalance interval, repeat

## Appendix E: Glossary

**Balance Manager** — A shared on-chain object that holds all token balances for a DeepBook account. One owner, up to 1000 authorized traders.

**CLOB (Central Limit Order Book)** — A trading system where buyers and sellers post limit orders at specific prices, and the system matches them. DeepBook is a CLOB implemented as a Sui smart contract.

**DEEP Token** — The native utility token for DeepBook. Required for trading fees. Can be staked for reduced fees and governance voting.

**Grid Strategy** — The market maker's approach: place N buy orders below the mid-price and N sell orders above it, evenly spaced, then cancel and re-place them every rebalance interval.

**Move** — The smart contract programming language used by Sui. DeepBook's core logic is written in Move.

**Pool** — A DeepBook trading venue for a specific token pair (e.g., DEEP/SUI). Contains a Book (order matching engine), State (user data, volumes, governance), and Vault (settlement).

**POST_ONLY** — An order restriction that ensures the order is a maker order (adds liquidity). If it would immediately match, it's rejected instead. The market maker uses this exclusively.

**PriceInfoObject** — A Sui on-chain object created by the Pyth oracle contract that stores the latest price for a specific asset.

**Pyth Network** — A decentralized oracle network that provides real-time price data. The oracle service fetches SUI and DEEP prices from Pyth and publishes them on-chain.

## Appendix F: Important Files

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
| `sandbox/scripts/utils/pool.ts`           | Pool and margin pool creation logic                                                     |
| `sandbox/scripts/utils/oracle.ts`         | Pyth oracle setup (PriceInfoObject creation)                                            |
| `sandbox/scripts/oracle-service/index.ts` | Oracle service entry point — fetches Pyth prices, submits update txs                    |
| `sandbox/scripts/market-maker/index.ts`   | Market maker entry point — grid strategy, order placement                               |
| `sandbox/faucet/src/index.ts`             | Faucet HTTP server (Hono)                                                               |
| `sandbox/faucet/src/routes/faucet.ts`     | POST /faucet endpoint — validates requests, dispatches SUI or DEEP                      |
| `sandbox/dashboard/src/App.tsx`           | Dashboard React app — Health, Market Maker, Faucet, Deployment pages                    |
| `sandbox/packages/example_contract/`      | Template for custom Move contracts that depend on DeepBook                              |
| `sandbox/deployments/localnet.json`       | Generated deployment manifest with all addresses and IDs                                |
| `sandbox/Pub.localnet.toml`               | Generated publish manifest for Sui CLI dependency resolution                            |
| `external/deepbook/`                      | Git submodule — DeepBook V3 Move smart contracts and Rust crates                        |

## Appendix G: Submodule Note

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

## Appendix H: Contributing

### Pre-commit hooks

This repository uses [pre-commit](https://pre-commit.com/) to check code quality and formatting before commits:

| Hook                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| **check-merge-conflict** | Prevents committing merge conflict markers         |
| **check-yaml**           | Validates YAML syntax                              |
| **trailing-whitespace**  | Removes trailing whitespace                        |
| **check-symlinks**       | Ensures symlinks point to valid files              |
| **end-of-file-fixer**    | Ensures files end with a newline                   |
| **mixed-line-ending**    | Normalizes line endings (LF)                       |
| **editorconfig-checker** | Validates files match `.editorconfig` rules        |
| **prettier**             | Checks formatting (4-space indent, 100-char width) |

Activate the hooks after installing `pre-commit`:

```bash
pre-commit install
```

Run checks manually:

```bash
# Run all hooks on staged files
pre-commit run

# Run all hooks on all files
pre-commit run --all-files

# Fix formatting violations
npx prettier --write .
```

### Integration tests

```bash
cd sandbox

# Run all integration tests
pnpm test:integration

# Run a specific test by filename pattern
pnpm test:integration deploy-all-e2e
pnpm test:integration deploy-pipeline
```

Test files live in `sandbox/scripts/__tests__/`. Tests run with a single fork to prevent concurrent localnet instances.

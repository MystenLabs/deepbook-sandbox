# Getting Started with DeepBook Sandbox

This guide walks you through setting up a local DeepBook V3 environment, deploying your first Move contract against it, and interacting with the order book — all in under 15 minutes.

## What you'll have running

By the end of this guide, your machine will be running:

- A **private Sui blockchain** (localnet) with the full DeepBook protocol deployed
- An **oracle service** pushing real-time SUI and DEEP prices on-chain
- A **market maker** providing liquidity to two trading pools (DEEP/SUI, SUI/USDC)
- An **indexer + REST API** serving order book and trade data
- A **web dashboard** for monitoring everything at a glance
- A **faucet** for getting test SUI and DEEP tokens

---

## 1. Install prerequisites

| Tool               | Install                                                                                | Verify                                      |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Docker Desktop** | [docker.com](https://docs.docker.com/get-docker/) (allocate **8 GB+ RAM** in settings) | `docker --version`                          |
| **Node.js 18+**    | `brew install node` or [nodejs.org](https://nodejs.org/)                               | `node --version`                            |
| **pnpm**           | `npm install -g pnpm`                                                                  | `pnpm --version`                            |
| **Sui CLI**        | `brew install sui`                                                                     | `sui --version` (1.63.2–1.64.x recommended) |

> Make sure the Docker daemon is running (whale icon in your menu bar) before continuing.

## 2. Clone and install

```bash
git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git
cd deepbook-sandbox/sandbox
pnpm install
```

> The `--recurse-submodules` flag pulls in the DeepBook V3 source code that the deploy script needs. If you already cloned without it, run `git submodule update --init --recursive` to fix it.

## 3. Deploy everything

```bash
pnpm deploy-all
```

That single command does a lot behind the scenes:

1. Starts a Sui localnet node and PostgreSQL in Docker
2. Publishes six Move packages (token, deepbook, pyth, usdc, margin, liquidation)
3. Creates trading pools and sets up oracles
4. Starts the indexer, REST API, market maker, oracle service, faucet, and dashboard

When you see **"DeepBook Sandbox Ready!"**, everything is up.

> **First run takes several minutes** — Docker images download and Rust services compile from source. Add `--quick` to skip the Rust build and use pre-built images instead: `pnpm deploy-all --quick`

## 4. Verify it works

Open the dashboard at **http://localhost:5173** — the Health page shows green status for all services.

Or verify from the terminal:

```bash
# Oracle is pushing prices
curl http://localhost:9010/

# Market maker is placing orders
curl http://localhost:3001/health

# All containers are healthy
docker compose ps
```

### Endpoints at a glance

| Service             | URL                          |
| ------------------- | ---------------------------- |
| Dashboard           | http://localhost:5173        |
| Sui RPC             | http://localhost:9000        |
| DeepBook REST API   | http://localhost:9008        |
| Faucet (SUI + DEEP) | http://localhost:9009        |
| Oracle status       | http://localhost:9010        |
| Market maker health | http://localhost:3001/health |

## 5. Get test tokens

The faucet at port 9009 distributes both SUI and DEEP tokens. Your deployer address already has funds, but you can request tokens for any address:

```bash
# Get your deployer address (already configured by deploy-all)
sui client active-address

# Request DEEP tokens (default 1000, max 10000 per request)
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYOUR_ADDRESS","token":"DEEP","amount":1000}'

# Request SUI tokens
curl -X POST http://localhost:9009/faucet \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYOUR_ADDRESS","token":"SUI"}'
```

You can also use the dashboard's **Faucet** tab with a connected Sui wallet.

## 6. Build your first contract

Now that DeepBook is running locally, you can write Move contracts that interact with it.

### Copy the template

```bash
cp -r packages/example_contract packages/my_contract
```

### Edit your contract

Open `packages/my_contract/sources/example_contract.move` (rename the file if you like). The template shows how to import DeepBook types:

```move
module my_contract::my_contract;

use deepbook::pool::Pool;
use token::deep::DEEP;
use usdc::usdc::USDC;

/// Example: read the best bid price from a pool
public fun best_bid(pool: &Pool<USDC, DEEP>): u64 {
    // Your logic here
    0
}
```

### Update Move.toml

Edit `packages/my_contract/Move.toml` — change the package name and keep the dependencies you need:

```toml
[package]
name = "my_contract"
edition = "2024"

[dependencies]
deepbook = { local = "../../.external-packages/deepbook" }
token = { local = "../../.external-packages/token" }
usdc = { local = "../usdc" }

[environments]
localnet = "<chain-id>"   # copy this value from Pub.localnet.toml
```

> **Tip:** Run `head -5 ../Pub.localnet.toml` to see the chain ID. It looks like `localnet = "a62c4e17"`.

### Available dependencies

| Dependency           | Path                                          | What it provides               |
| -------------------- | --------------------------------------------- | ------------------------------ |
| `deepbook`           | `../../.external-packages/deepbook`           | Pools, orders, balance manager |
| `token`              | `../../.external-packages/token`              | DEEP coin type                 |
| `deepbook_margin`    | `../../.external-packages/deepbook_margin`    | Margin trading                 |
| `margin_liquidation` | `../../.external-packages/margin_liquidation` | Liquidation logic              |
| `pyth`               | `../pyth`                                     | Oracle price feeds             |
| `usdc`               | `../usdc`                                     | USDC coin type                 |

### Build and publish

```bash
cd packages/my_contract

# Check it compiles
sui move build --build-env localnet

# Publish to your localnet
sui client test-publish --build-env localnet --pubfile-path ../../Pub.localnet.toml
```

The `--pubfile-path` flag tells the compiler where to find the already-published DeepBook packages on your local chain.

## 7. View deployment info

After deploying, you can inspect all package IDs, pool addresses, and oracle objects:

```bash
# Full deployment manifest (JSON)
curl http://localhost:9009/manifest

# Or check the generated files
cat deployments/localnet.json   # JSON manifest
cat .env                        # All env vars with package IDs
cat Pub.localnet.toml           # Sui CLI publish manifest
```

The dashboard's **Deployment** tab also shows all addresses with explorer links.

## 8. Iterate

You only need `pnpm deploy-all` once. After that, keep re-publishing your contract as many times as you want — the chain and all services stay running:

```bash
# Edit your contract, then re-publish
cd packages/my_contract
sui client test-publish --build-env localnet --pubfile-path ../../Pub.localnet.toml
```

Other useful commands while working:

```bash
# View market maker activity
docker compose logs -f market-maker

# Check oracle price updates
docker compose logs -f oracle-service

# Query the chain directly (sui CLI is already configured)
sui client gas
sui client objects
```

## 9. Clean up

When you're done, tear everything down:

```bash
pnpm down
```

This stops all containers, removes Docker volumes (chain data, database), and cleans auto-generated keys from `.env`. Your source code is never touched.

> **Warning:** Chain state is destroyed on teardown. Save any important addresses or object IDs before running `pnpm down`.

To start fresh, just run `pnpm deploy-all` again.

---

## Troubleshooting

| Problem                                       | Solution                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `deploy-all` hangs at "Waiting for Sui RPC"   | Docker isn't running. Start Docker Desktop and try again                          |
| "Timed out waiting for .sui-keystore"         | Wrong `SUI_TOOLS_IMAGE` for your CPU. Check `sui --version` and `.env.example`    |
| First run is very slow                        | Normal — Rust compilation takes a few minutes. Use `--quick` for pre-built images |
| Port conflict on 9000 or 5432                 | Another service is using the port. Stop it or edit `docker-compose.yml`           |
| Contract build fails: "unresolved dependency" | Run `pnpm deploy-all` first — it creates the `.external-packages/` directory      |
| Duplicate dependency error on publish         | Use absolute paths in `Move.toml` (see `Pub.localnet.toml` for exact values)      |

For more details, see the full [README](./README.md).

---

## Next steps

- **[README](./README.md)** — Architecture diagrams, configuration reference, data flows, and all commands
- **[Example contract](./sandbox/packages/example_contract/README.md)** — Detailed guide for building custom contracts
- **[DeepBook contract docs](https://docs.sui.io/standards/deepbookv3)** — How pools, orders, and balance managers work
- **[DeepBook SDK docs](https://docs.sui.io/standards/deepbookv3-sdk)** — TypeScript SDK for interacting with DeepBook
- **[Move language](https://docs.sui.io/concepts/sui-move-concepts)** — Sui Move programming concepts

# DeepBook indexer - WIP

The DeepBook Indexer uses sui-indexer-alt framework for indexing DeepBook move events. 
It processes checkpoints from the Sui blockchain and extracts event data for use in 
applications or analysis.

---

## Getting Started

### Prerequisites

Ensure that the following dependencies are installed:

- **Rust** (latest stable version recommended)
- **PostgreSQL** (version 13 or higher)

### Installation

Clone the repository:

```bash
git clone https://github.com/MystenLabs/deepbookv3.git
cd deepbookv3/crates/indexer
```

### Running the Indexer

To run the DeepBook Indexer, you need to specify the environment and which packages to index:

#### Basic Usage

```bash
DATABASE_URL="postgresql://user:pass@localhost/test_db" \
cargo run --package deepbook-indexer -- --env testnet --packages deepbook
```

#### Parameters

- `--env` (required) – Choose the SUI network environment:
  - `testnet` – For development and testing
  - `mainnet` – For production (note: margin trading not yet deployed on mainnet)

- `--packages` (required) – Specify which event types to index:
  - `deepbook` – Core DeepBook events (orders, trades, pools, governance)
  - `deepbook-margin` – Margin trading events (lending, borrowing, liquidations)
  - You can specify multiple packages: `--packages deepbook deepbook-margin`

- `--database-url` (optional) – PostgreSQL connection string. Can also be set via `DATABASE_URL` environment variable.

- `--metrics-address` (optional, default: `0.0.0.0:9184`) – Prometheus metrics endpoint address.

#### Examples

**Index only core DeepBook events on testnet:**
```bash
DATABASE_URL="postgresql://user:pass@localhost/test_db" \
cargo run --package deepbook-indexer -- --env testnet --packages deepbook
```

**Index both core and margin events on testnet:**
```bash
DATABASE_URL="postgresql://user:pass@localhost/test_db" \
cargo run --package deepbook-indexer -- --env testnet --packages deepbook deepbook-margin
```

**Index only core events on mainnet:**
```bash
DATABASE_URL="postgresql://user:pass@localhost/test_db" \
cargo run --package deepbook-indexer -- --env mainnet --packages deepbook
```

#### Important Notes

- **Margin events on mainnet**: The margin trading package is not yet deployed on mainnet, so `--packages deepbook-margin` will fail on mainnet.
- **Database migrations**: The indexer automatically runs database migrations on startup.
- **Environment variable**: You can set `DATABASE_URL` as an environment variable instead of using the `--database-url` parameter.

---

## Localnet Support

This fork of the indexer supports indexing a local Sui node. This is useful for development
and testing DeepBook without needing testnet/mainnet access.

### Requirements for Localnet

1. **Local Sui node with checkpoint export** - The Sui node must be configured to export
   checkpoint files to a directory. See `sandbox/config/fullnode.yaml` for configuration.

2. **Deployed DeepBook package** - You need the package address(es) from deploying DeepBook
   to your local node.

### Localnet CLI Arguments

- `--env localnet` - Required to enable localnet mode
- `--local-ingestion-path <PATH>` - Required for localnet. Directory containing checkpoint files
- `--core-packages <ADDRESSES>` - Required for localnet. Comma-separated DeepBook package addresses
- `--margin-packages <ADDRESSES>` - Optional. Comma-separated margin package addresses

### Running on Localnet

**Step 1: Start the local Sui node with checkpoint export**

```bash
# Using Docker Compose (recommended)
cd sandbox
docker compose --profile localnet-full up -d
```

**Step 2: Deploy DeepBook to localnet**

```bash
sui client publish external/deepbook/packages/deepbook --gas-budget 500000000
# Note the package address from the output
```

**Step 3: Run the indexer**

```bash
# Set the package address from Step 2
export DEEPBOOK_PACKAGE_ID=0x<your-package-address>

# Run directly
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/deepbook" \
cargo run --package deepbook-indexer -- \
  --env localnet \
  --local-ingestion-path /path/to/checkpoints \
  --core-packages $DEEPBOOK_PACKAGE_ID \
  --packages deepbook

# Or update .env and use Docker Compose
echo "DEEPBOOK_PACKAGE_ID=$DEEPBOOK_PACKAGE_ID" >> sandbox/.env
docker compose --profile localnet-full up -d
```

### Troubleshooting Localnet

**No checkpoint files appearing:**
- Ensure the Sui node is configured with `data-ingestion-dir` in its fullnode.yaml
- Check the Sui node logs for checkpoint execution errors
- The checkpoint export feature has known reliability issues (GitHub #22335)

**Indexer not processing events:**
- Verify the package address(es) match your deployed contracts
- Check that `--packages deepbook` matches the events you want to index
- Review indexer logs for event matching failures

---
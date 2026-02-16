# DeepBook Sandbox

A toolset for reducing builder friction with one-liner deployments,
Dockerized stack, and a web dashboard for DeepBook V3 instances.

## Overview

This repository provides a complete local development environment
for DeepBook V3, including:

- Dockerized Sui localnet with faucet
- PostgreSQL database
- DeepBook Move package deployment
- DeepBook indexer
- Pyth oracle price feeds with automated updates (oracle service)
- Pre-configured DEEP-SUI liquidity pool

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/installation)
- [Sui CLI](https://docs.sui.io/build/install) installed
  (`sui` command available in PATH)
- (OPTIONAL) [pre-commit](https://pre-commit.com/#install) for git
  hook management (`brew install pre-commit`)

## Quick Start

1. **Install dependencies:**

    ```bash
    pnpm install
    ```

2. **Deploy the full stack:**

    ```bash
    pnpm deploy-all
    ```

    This single command will:

    - Start a Sui localnet in Docker (with faucet)
    - Start a PostgreSQL database
    - Deploy all DeepBook Move packages
      (token, deepbook, deepbook_margin, pyth, etc.)
    - Start the DeepBook indexer
    - Create Pyth oracle price feeds for SUI and DEEP
    - Start the oracle service (updates prices every 10s)
    - Create a DEEP-SUI liquidity pool
    - Generate a config file with all deployment artifacts

3. **Access the environment:**

    After deployment completes, you'll have:

    - **RPC endpoint**: `http://localhost:9000`
    - **Faucet**: `http://localhost:9123`
    - **Oracle status**: `http://localhost:9010`
      (latest SUI/DEEP prices)
    - **Deployment config**:
      `deployments/{DATE}_{TIME}_{NETWORK}.json`

## Configuration

The deployment script writes a JSON file to the `deployments/`
folder with the format `{DATE}_{TIME}_{NETWORK}.json`, for example:

```json
{
    "network": {
        "type": "localnet",
        "rpcUrl": "http://localhost:9000",
        "faucetUrl": "http://localhost:9123"
    },
    "packages": {
        "token": { "packageId": "0x...", "...": "..." },
        "deepbook": { "packageId": "0x...", "...": "..." }
    },
    "pool": {
        "poolId": "0x...",
        "baseCoin": "0x...::deep::DEEP",
        "quoteCoin": "0x2::sui::SUI"
    }
}
```

Use this config file to interact with your deployed contracts.

## Usage

### Testing with the Faucet

Request SUI tokens for an address:

```bash
curl http://localhost:9123/gas -X POST \
    -H "Content-Type: application/json" \
    -d '{"FixedAmountRequest":{"recipient":"YOUR_ADDRESS"}}'
```

### Querying the RPC

Get chain information:

```bash
curl http://localhost:9000 -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"sui_getChainIdentifier","id":1}'
```

### Using the Deployed Packages

The deployed package IDs and object IDs are in the latest file
under `deployments/`. Use them with the Sui SDK:

```typescript
import { SuiClient } from "@mysten/sui/client";
import config from "./deployments/latest_localnet.json";

const client = new SuiClient({ url: config.network.rpcUrl });

// Query the deployed pool
const pool = await client.getObject({
    id: config.pool.poolId,
    options: { showContent: true },
});
```

## Contributing

### Pre-commit hooks

This repository uses [pre-commit](https://pre-commit.com/) to
automatically check code quality and formatting before commits.
The following checks run on every commit:

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

#### Setup

After installing `pre-commit` (see [Prerequisites](#prerequisites)),
activate the hooks:

```bash
pre-commit install
```

#### Running checks manually

```bash
# Run all hooks on staged files
pre-commit run

# Run all hooks on all files
pre-commit run --all-files

# Run a specific hook
pre-commit run prettier --all-files
```

#### Skipping hooks

To commit without running pre-commit hooks (use sparingly):

```bash
git commit --no-verify
```

#### Fixing violations

Most hooks auto-fix issues (whitespace, line endings).
For formatting violations:

```bash
npx prettier --write .
```

For EditorConfig violations, ensure your editor respects
`.editorconfig` settings.

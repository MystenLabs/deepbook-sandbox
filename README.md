# DeepBook Sandbox

A toolset for reducing builder friction with one-liner deployments, Dockerized stack, and a web dashboard for DeepBook V3 instances.

## Overview

This repository provides a complete local development environment for DeepBook V3, including:

- Dockerized Sui localnet with faucet
- PostgreSQL database
- DeepBook Move package deployment
- DeepBook indexer
- Pre-configured DEEP-SUI liquidity pool

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/installation)
- [Sui CLI](https://docs.sui.io/build/install) installed (`sui` command available in PATH)

## Quick Start

1. **Install dependencies:**

   ```bash
   pnpm install
   ```

2. **Deploy the full stack:**

   ```bash
   pnpm deploy
   ```

   This single command will:
   - Start a Sui localnet in Docker (with faucet)
   - Start a PostgreSQL database
   - Deploy all DeepBook Move packages (token, deepbook, deepbook_margin, etc.)
   - Start the DeepBook indexer
   - Create a DEEP-SUI liquidity pool
   - Generate a config file with all deployment artifacts

3. **Access the environment:**

   After deployment completes, you'll have:
   - **RPC endpoint**: `http://localhost:9000`
   - **Faucet**: `http://localhost:9123`
   - **Deployment config**: `scripts/config/deployed.json`

## Configuration

The deployment script generates a `scripts/config/deployed.json` file containing:

```json
{
  "network": {
    "type": "localnet",
    "rpcUrl": "http://localhost:9000",
    "faucetUrl": "http://localhost:9123"
  },
  "packages": {
    "token": { "packageId": "0x...", ... },
    "deepbook": { "packageId": "0x...", ... },
    ...
  },
  "pool": {
    "poolId": "0x...",
    "baseCoin": "0x2::sui::SUI",
    "quoteCoin": "0x...::deep::DEEP"
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

The deployed package IDs and object IDs are available in `scripts/config/deployed.json`. Use them with the Sui SDK:

```typescript
import { SuiClient } from '@mysten/sui/client';
import config from './scripts/config/deployed.json';

const client = new SuiClient({ url: config.network.rpcUrl });

// Query the deployed pool
const pool = await client.getObject({
  id: config.pool.poolId,
  options: { showContent: true }
});
```

## Contributing

Contributions are welcome! Please open an issue or pull request.

## License

Apache-2.0

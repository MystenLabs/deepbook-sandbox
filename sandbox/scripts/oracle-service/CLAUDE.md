# Oracle Service

The oracle service runs as a Docker container and provides automated price feed updates for localnet testing:

- **Deployment**: Runs in Docker as part of the `localnet` profile, started automatically by `pnpm deploy-all`
- **Purpose**: Updates Pyth price oracle contracts for SUI, DEEP, and USDC every 10 seconds
- **Status endpoint**: `http://localhost:9010` — returns JSON with latest prices, update count, and errors
- **Data Source**: Fetches historical price data from Pyth Network API (24h ago)
- **Env vars** (set automatically by deploy-all):
  - `ORACLE_PRIVATE_KEY`: Dedicated Ed25519 keypair (auto-generated, avoids gas coin conflicts with market maker)
  - `PYTH_PACKAGE_ID`: Deployed pyth package address
  - `DEEP_PRICE_INFO_OBJECT_ID`: DEEP PriceInfoObject ID
  - `SUI_PRICE_INFO_OBJECT_ID`: SUI PriceInfoObject ID
  - `USDC_PRICE_INFO_OBJECT_ID`: USDC PriceInfoObject ID
- **Price Feeds**:
  - SUI: `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`
  - DEEP: `0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff`
  - USDC: `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a`

See [./README.md](./README.md) for detailed documentation.

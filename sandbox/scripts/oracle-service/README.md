# Oracle Service

Automated service for updating Pyth price feeds on DeepBook localnet.

## Overview

This service continuously fetches historical price data from Pyth Network and updates the SUI and DEEP price oracle contracts on your localnet. It runs every 10 seconds to keep prices up-to-date for testing DeepBook margin trading features.

## Features

- 🔄 **Automatic Updates**: Updates price feeds every 10 seconds
- 📊 **Historical Data**: Fetches prices from 24 hours ago using Pyth's timestamp API
- 🎯 **SUI & DEEP**: Updates both price feeds simultaneously
- 📡 **Real Pyth Data**: Uses actual Pyth Network price feeds:
    - SUI: `0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744`
    - DEEP: `0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff`
- 🔧 **Self-Configuring**: Automatically loads deployment configuration

## Prerequisites

1. Deploy the DeepBook contracts and Pyth oracles:

    ```bash
    pnpm deploy-all
    ```

2. Make sure localnet is running (started by deploy-all)

## Usage

Start the oracle service:

```bash
pnpm oracle-service
```

You should see output like:

```
🔮 Starting Oracle Service...

📄 Loaded deployment: 2026-02-11_09-16-24_localnet.json
📋 Configuration:
  Network: localnet
  Pyth Package: 0xb0474b7af6d3f648487ee4f640c727fcaf159a97c0d8d51f341d9945c7baee2d
  SUI Oracle: 0x351afac57c5787d24f1d20faeae0715ecd0e7cb96f56ce1366d91c8fabf01910
  DEEP Oracle: 0xcc32bd60c1ae0b393b402ea0e18c0884f40f0279018fb72f0da3e7f77f4b4806
  Update Interval: 3s

✅ Connected to chain: 4c78adac

🚀 Starting price feed updates...

📡 Fetching price updates from Pyth (timestamp: 1739173584)...
  ✅ Received 2 price feeds
🔄 Updating on-chain price feeds...
  ✅ Updated price feeds (digest: 8a9b2c3d...)
    SUI:  $3.45000000
    DEEP: $0.02150000
  ⏱️  Update #1 completed in 1234ms (errors: 0)

👀 Oracle service is running. Press Ctrl+C to stop.
```

Stop the service with `Ctrl+C`.

## Configuration

Default configuration in `index.ts`:

```typescript
{
  pythApiUrl: 'https://benchmarks.pyth.network',
  priceFeeds: {
    sui: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
    deep: '0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff'
  },
  updateIntervalMs: 10000,        // 10 seconds
  historicalDataHours: 24        // 24 hours ago
}
```

## Troubleshooting

### "No deployment files found"

Run `pnpm deploy-all` first to deploy the contracts.

### "No pythOracles found in deployment"

The deployment didn't include Pyth oracles. This only works on localnet. Make sure you're using the latest deployment script.

### "Transaction failed"

Check that:

- Localnet is still running
- Your deployer address has sufficient SUI balance
- The PriceInfoObject IDs in the deployment are correct

### Connection errors to Pyth API

The Pyth benchmark API may be rate-limited or temporarily unavailable. The service will continue retrying on the next interval.

## Testing

Once the service is running, you can verify the updates by checking the PriceInfoObjects:

```bash
sui client object <PRICE_INFO_OBJECT_ID> --json
```

The `price_info.price_feed.price.timestamp` field should update every 3 seconds.

# DeepBook V3 Market Maker

A TypeScript market maker service for DeepBook V3 on Sui. The service maintains order book depth using a grid strategy, placing limit orders on both sides of the mid-price with automatic rebalancing.

## Prerequisites

1. Deploy DeepBook to localnet:

   ```bash
   cd sandbox
   cp .env.example .env
   # Edit .env: set PRIVATE_KEY and SUI_TOOLS_IMAGE
   pnpm install
   pnpm deploy-all
   ```

2. Ensure you have SUI in your wallet (the faucet is called during deploy-all)

## Usage

The market maker runs as a Docker container, started automatically by `pnpm deploy-all`. It receives its configuration through environment variables set in `.env`.

```bash
cd sandbox
pnpm deploy-all   # Deploys contracts and starts the market maker container
```

To view logs:
```bash
docker compose logs -f market-maker
```

## Configuration

### Required Environment Variables (set by deploy-all)

| Variable | Description |
|----------|-------------|
| `DEEPBOOK_PACKAGE_ID` | Deployed DeepBook package address |
| `POOL_ID` | DEEP/SUI pool object ID |
| `BASE_COIN_TYPE` | Base coin type (e.g. `0x...::deep::DEEP`) |
| `DEPLOYER_ADDRESS` | Deployer's Sui address |
| `PYTH_PACKAGE_ID` | Deployed Pyth package address |
| `DEEP_PRICE_INFO_OBJECT_ID` | DEEP PriceInfoObject ID |
| `SUI_PRICE_INFO_OBJECT_ID` | SUI PriceInfoObject ID |

### Tunable Parameters

| Variable                   | Description                                                        | Default                    |
| -------------------------- | ------------------------------------------------------------------ | -------------------------- |
| `MM_FALLBACK_MID_PRICE`    | Fallback mid price when oracle is unavailable (9 decimals for SUI) | `100000000` (0.1 DEEP/SUI) |
| `MM_SPREAD_BPS`            | Spread in basis points                                             | `10` (0.1%)                |
| `MM_LEVELS_PER_SIDE`       | Number of orders per side                                          | `5`                        |
| `MM_LEVEL_SPACING_BPS`     | Spacing between levels in bps                                      | `5` (0.05%)                |
| `MM_ORDER_SIZE_BASE`       | Order size in base units (6 decimals for DEEP)                     | `10000000` (10 DEEP)       |
| `MM_REBALANCE_INTERVAL_MS` | Rebalance interval in ms                                           | `10000` (10s)              |
| `MM_HEALTH_CHECK_PORT`     | Health check server port                                           | `3000`                     |
| `MM_METRICS_PORT`          | Prometheus metrics port                                            | `9090`                     |

## Endpoints

### Health Check

```bash
curl http://localhost:3000/health
```

Response:

```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "uptime": 60000,
  "details": {
    "activeOrders": 10,
    "totalOrdersPlaced": 50,
    "totalRebalances": 5,
    "errors": 0
  }
}
```

### Readiness Check

```bash
curl http://localhost:3000/ready
```

Response:

```json
{
  "ready": true,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "checks": {
    "balanceManager": true,
    "pool": true
  }
}
```

### Prometheus Metrics

```bash
curl http://localhost:9090/metrics
```

Available metrics:

- `mm_orders_placed_total` - Counter of total orders placed
- `mm_orders_canceled_total` - Counter of total orders canceled
- `mm_rebalances_total` - Counter of rebalance cycles
- `mm_active_orders` - Gauge of current active orders
- `mm_last_rebalance_timestamp_seconds` - Timestamp of last rebalance
- `mm_errors_total` - Counter of errors

## Grid Strategy

The market maker uses a simple grid strategy:

1. Calculate N price levels above and below the mid price
2. Each level is spaced by `levelSpacingBps` from the previous
3. The closest bid/ask are `spreadBps/2` from mid price
4. All orders are POST_ONLY (maker only, no taker fees)
5. Every `rebalanceIntervalMs`, cancel all orders and replace the grid

Example with defaults (mid=0.1 SUI, spread=10bps, 5 levels, 5bps spacing):

```
Ask Level 5: 0.10125 SUI
Ask Level 4: 0.10100 SUI
Ask Level 3: 0.10075 SUI
Ask Level 2: 0.10050 SUI
Ask Level 1: 0.10025 SUI  <- Best Ask
----- Mid: 0.10000 SUI -----
Bid Level 1: 0.09975 SUI  <- Best Bid
Bid Level 2: 0.09950 SUI
Bid Level 3: 0.09925 SUI
Bid Level 4: 0.09900 SUI
Bid Level 5: 0.09875 SUI
```

## Graceful Shutdown

Press `Ctrl+C` to stop the market maker. It will:

1. Cancel all outstanding orders
2. Stop the health and metrics servers
3. Exit cleanly

## Notes

- **DEEP tokens**: On localnet, DEEP tokens need to be minted via TreasuryCap. The market maker will attempt to place orders but they may fail if there's insufficient DEEP balance for asks. Fund the BalanceManager with DEEP before starting in production.

- **Pyth oracle pricing**: The market maker fetches live DEEP/SUI prices from the Pyth Network oracle. If the oracle is temporarily unavailable, it falls back to the last known price, then to `MM_FALLBACK_MID_PRICE`.

- **POST_ONLY orders**: All orders use POST_ONLY restriction to ensure they're maker orders only. This prevents accidental taker trades and associated fees.

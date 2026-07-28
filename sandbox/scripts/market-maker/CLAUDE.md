# Market Maker

## Configuration

Environment variables read by the market maker (`config.ts` / `index.ts`):

- `MM_POOLS` - JSON array of per-pool configs (pool id, order size, fallback mid price); written by `deploy-all.ts`
- `MM_SPREAD_BPS` - Spread in basis points (code default: 500 = 5%; docker-compose sets 10)
- `MM_LEVELS_PER_SIDE` - Orders per side (default: 30)
- `MM_LEVEL_SPACING_BPS` - Spacing between grid levels in basis points (default: 100)
- `MM_REBALANCE_INTERVAL_MS` - Rebalance interval (default: 10000)
- `MM_HEALTH_CHECK_PORT` - Health server port (default: 3000)
- `MM_METRICS_PORT` - Prometheus metrics port (default: 9090)

Per-pool order sizes and oracle-fallback mid prices come from `MM_POOLS`, not
env vars — `MM_ORDER_SIZE_BASE` and `MM_FALLBACK_MID_PRICE` appear in older
docs but are never read.

See [./README.md](./README.md) for full documentation.

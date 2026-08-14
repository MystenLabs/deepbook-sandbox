import { useState, useRef } from "react";
import {
    useMarketMakerOrders,
    useForkBooks,
    useForkManifest,
    useOraclePrices,
    usePoolDetails,
    useRecentTrades,
    REFETCH_INTERVAL,
    FORK_LEVELS_PER_SIDE,
} from "./hooks";
import { PoolSelector } from "./pool-selector";
import { OrderBook } from "./order-book";
import { DepthChart } from "./depth-chart";
import { RecentTrades } from "./recent-trades";
import { StatCards } from "./stat-cards";
import type { OrdersResponse, PoolOrders } from "./types";

/** Spread of a pool's displayed book, in basis points — the fork stand-in
 *  for the MM service's configured spreadBps (there, config; here, measured). */
function measuredConfig(pool: PoolOrders | undefined): OrdersResponse["config"] | undefined {
    if (!pool) return undefined;
    const bids = pool.orders.filter((o) => o.isBid);
    const asks = pool.orders.filter((o) => !o.isBid);
    if (bids.length === 0 || asks.length === 0) return undefined;
    const bestBid = Math.max(...bids.map((o) => o.price));
    const bestAsk = Math.min(...asks.map((o) => o.price));
    const mid = (bestBid + bestAsk) / 2;
    if (mid === 0) return undefined;
    return {
        spreadBps: Math.round(((bestAsk - bestBid) / mid) * 10_000),
        levelsPerSide: FORK_LEVELS_PER_SIDE,
        levelSpacingBps: 0,
    };
}

export function MarketMakerPage() {
    const [selectedPool, setSelectedPool] = useState(0);

    // Fork mode reads the book straight off the chain (the MM service and
    // oracle service are retired there); localnet keeps the MM's own feeds.
    const fork = useForkManifest();
    const mmOrders = useMarketMakerOrders(!fork);
    const forkBooks = useForkBooks(fork);
    const oracle = useOraclePrices(!fork);

    const active = fork ? forkBooks : mmOrders;
    const source = {
        pools: active.data?.pools,
        isLoading: active.isLoading,
        isError: active.isError,
        isFetching: active.isFetching,
        refetch: active.refetch,
    };

    const pools = source.pools ?? [];
    // Clamp selected index if pool count shrinks after a data refetch
    const clampedIndex = pools.length > 0 ? Math.min(selectedPool, pools.length - 1) : 0;
    const pool = pools[clampedIndex];

    // Track the pair name for each pool index so we never fall back to
    // a different pool's cached data when pool data is momentarily empty.
    const pairByIndexRef = useRef<Map<number, string>>(new Map());
    if (pool) {
        pairByIndexRef.current.set(clampedIndex, pool.pair);
    }
    const pair = pool?.pair ?? pairByIndexRef.current.get(clampedIndex) ?? "DEEP/SUI";

    const poolKey = pair.replace("/", "_"); // "DEEP/SUI" → "DEEP_SUI"
    const trades = useRecentTrades(poolKey);

    // Keep the last non-empty pool data *per pair* so the UI stays stable
    // during MM rebalance cycles (which briefly return 0 orders).
    const lastGoodPoolsRef = useRef<Map<string, PoolOrders>>(new Map());
    const hasOrders = pool && pool.orders.length > 0;
    if (hasOrders) {
        lastGoodPoolsRef.current.set(pool.pair, pool);
    }
    const displayPool = hasOrders ? pool : lastGoodPoolsRef.current.get(pair);

    const poolDetails = usePoolDetails(poolKey, displayPool?.midPrice ?? null);
    const config = fork ? measuredConfig(displayPool) : mmOrders.data?.config;

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Market Maker</h1>
                <p className="text-xs text-muted-foreground pb-2">
                    {fork ? "Live pool order books, read from the fork chain" : "Order book grid"}
                    {" — auto-refreshes every "}
                    {REFETCH_INTERVAL / 1000}s
                </p>
                <PoolSelector
                    pools={pools}
                    selectedIndex={clampedIndex}
                    onSelect={setSelectedPool}
                />
            </div>

            {/* Depth Chart + Order Book + Recent Trades */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
                <DepthChart
                    key={`depth-${pair}`}
                    pool={displayPool}
                    pair={pair}
                    isLoading={source.isLoading}
                    isError={source.isError}
                />
                <OrderBook
                    key={`book-${pair}`}
                    pool={displayPool}
                    pair={pair}
                    isLoading={source.isLoading}
                    isError={source.isError}
                    isFetching={source.isFetching}
                    onRefresh={() => source.refetch()}
                />
                <RecentTrades
                    key={`trades-${pair}`}
                    trades={trades.data}
                    pair={pair}
                    isLoading={trades.isLoading}
                    isError={trades.isError}
                />
            </div>

            {/* Stats */}
            <StatCards
                pool={displayPool}
                config={config}
                oraclePrices={oracle.data?.prices}
                poolDetails={poolDetails.data}
                poolDetailsLoading={poolDetails.isLoading}
                pair={pair}
                isLoading={source.isLoading}
            />
        </div>
    );
}

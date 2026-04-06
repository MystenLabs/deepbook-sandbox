import { useState, useRef } from "react";
import { useMarketMakerOrders, useOraclePrices, usePoolDetails, REFETCH_INTERVAL } from "./hooks";
import { PoolSelector } from "./pool-selector";
import { OrderBook } from "./order-book";
import { DepthChart } from "./depth-chart";
import { StatCards } from "./stat-cards";
import type { PoolOrders } from "./types";

export function MarketMakerPage() {
    const [selectedPool, setSelectedPool] = useState(0);

    const orders = useMarketMakerOrders();
    const oracle = useOraclePrices();
    const poolKey = "DEEP_SUI"; // TODO: derive from selected pool pair
    const poolDetails = usePoolDetails(poolKey);

    const pools = orders.data?.pools ?? [];
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

    // Keep the last non-empty pool data *per pair* so the UI stays stable
    // during MM rebalance cycles (which briefly return 0 orders).
    const lastGoodPoolsRef = useRef<Map<string, PoolOrders>>(new Map());
    const hasOrders = pool && pool.orders.length > 0;
    if (hasOrders) {
        lastGoodPoolsRef.current.set(pool.pair, pool);
    }
    const displayPool = hasOrders ? pool : lastGoodPoolsRef.current.get(pair);

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Market Maker</h1>
                <p className="text-xs text-muted-foreground pb-2">
                    Order book grid — auto-refreshes every {REFETCH_INTERVAL / 1000}s
                </p>
                <PoolSelector
                    pools={pools}
                    selectedIndex={clampedIndex}
                    onSelect={setSelectedPool}
                />
            </div>

            {/* Depth Chart + Order Book side-by-side */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <DepthChart
                    key={`depth-${pair}`}
                    pool={displayPool}
                    pair={pair}
                    isLoading={orders.isLoading}
                    isError={orders.isError}
                />
                <OrderBook
                    key={`book-${pair}`}
                    pool={displayPool}
                    pair={pair}
                    isLoading={orders.isLoading}
                    isError={orders.isError}
                    isFetching={orders.isFetching}
                    onRefresh={() => orders.refetch()}
                />
            </div>

            {/* Stats */}
            <StatCards
                pool={displayPool}
                config={orders.data?.config}
                oraclePrices={oracle.data?.prices}
                poolDetails={poolDetails.data}
                poolDetailsLoading={poolDetails.isLoading}
                pair={pair}
                isLoading={orders.isLoading}
            />
        </div>
    );
}

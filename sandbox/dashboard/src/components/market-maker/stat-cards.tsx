import type { PoolOrders, OrdersResponse, OracleResponse } from "./types";
import type { PoolDetails } from "./hooks";
import { StatCard } from "./helpers";
import { formatPrice } from "./helpers";

/* ------------------------------------------------------------------ */
/*  Stat cards grid                                                    */
/* ------------------------------------------------------------------ */

interface StatCardsProps {
    pool: PoolOrders | undefined;
    config: OrdersResponse["config"] | undefined;
    oraclePrices: OracleResponse["prices"] | undefined;
    poolDetails?: PoolDetails;
    poolDetailsLoading?: boolean;
    pair: string;
    isLoading: boolean;
}

function getOraclePricesForPair(
    pair: string,
    prices?: OracleResponse["prices"],
): { base: string; quote: string; basePrice: string | null; quotePrice: string | null } {
    const [base, quote] = pair.split("/");
    const priceMap = prices as Record<string, string | null> | undefined;
    return {
        base,
        quote,
        basePrice: priceMap?.[base.toLowerCase()] ?? null,
        quotePrice: priceMap?.[quote.toLowerCase()] ?? null,
    };
}

export function StatCards({
    pool,
    config,
    oraclePrices,
    poolDetails,
    poolDetailsLoading,
    pair,
    isLoading,
}: StatCardsProps) {
    const oracle = getOraclePricesForPair(pair, oraclePrices);

    // Compute spread in absolute terms
    let spreadAbsolute: number | null = null;
    if (pool && config) {
        const bids = pool.orders.filter((o) => o.isBid);
        const asks = pool.orders.filter((o) => !o.isBid);
        const bestBid = bids.length > 0 ? Math.max(...bids.map((o) => o.price)) : null;
        const bestAsk = asks.length > 0 ? Math.min(...asks.map((o) => o.price)) : null;
        if (bestBid != null && bestAsk != null) {
            spreadAbsolute = bestAsk - bestBid;
        }
    }

    const pdLoading = poolDetailsLoading ?? false;

    return (
        <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                    label="On-chain Mid Price"
                    isLoading={pdLoading}
                    tooltip="Midpoint between best bid and best ask on the pool's order book"
                >
                    {poolDetails ? parseFloat(poolDetails.midPrice).toFixed(6) : "—"}
                </StatCard>
                <StatCard
                    label="Tick Size"
                    isLoading={pdLoading}
                    tooltip="Smallest allowed price increment for orders"
                >
                    {poolDetails?.tickSize ?? "—"}
                </StatCard>
                <StatCard
                    label="Lot Size"
                    isLoading={pdLoading}
                    tooltip="Smallest allowed quantity increment for orders"
                >
                    {poolDetails?.lotSize ?? "—"}
                </StatCard>
                <StatCard
                    label="Min Size"
                    isLoading={pdLoading}
                    tooltip="Minimum order quantity allowed on this pool"
                >
                    {poolDetails?.minSize ?? "—"}
                </StatCard>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <StatCard
                    label="Mid Price"
                    isLoading={isLoading}
                    tooltip="Market maker's calculated mid price from oracle feeds"
                >
                    {pool?.midPrice != null ? formatPrice(pool.midPrice, pair) : "—"}
                </StatCard>
                <StatCard
                    label="Spread"
                    isLoading={isLoading}
                    tooltip="Price gap between best bid and ask, in basis points"
                >
                    {config ? (
                        <>
                            {config.spreadBps} bps
                            {spreadAbsolute != null && (
                                <span className="ml-1 text-zinc-500 text-xs">
                                    ({formatPrice(spreadAbsolute, pair)})
                                </span>
                            )}
                        </>
                    ) : (
                        "—"
                    )}
                </StatCard>
                <StatCard
                    label="Active Orders"
                    isLoading={isLoading}
                    tooltip="Number of resting orders placed by the market maker"
                >
                    {pool?.orders.length ?? "—"}
                </StatCard>
                <StatCard
                    label="Levels / Side"
                    isLoading={isLoading}
                    tooltip="Number of price levels maintained on each side of the book"
                >
                    {config?.levelsPerSide ?? "—"}
                </StatCard>
                <StatCard
                    label={`Oracle ${oracle.base}`}
                    isLoading={isLoading}
                    tooltip={`${oracle.base}/USD price from Pyth Network oracle`}
                >
                    {oracle.basePrice ?? "—"}
                </StatCard>
                <StatCard
                    label={`Oracle ${oracle.quote}`}
                    isLoading={isLoading}
                    tooltip={`${oracle.quote}/USD price from Pyth Network oracle`}
                >
                    {oracle.quotePrice ?? "—"}
                </StatCard>
            </div>
        </>
    );
}

import type { PoolOrders, OrdersResponse, OracleResponse } from "./types";
import { StatCard } from "./helpers";
import { formatPrice } from "./helpers";

/* ------------------------------------------------------------------ */
/*  Stat cards grid                                                    */
/* ------------------------------------------------------------------ */

interface StatCardsProps {
    pool: PoolOrders | undefined;
    config: OrdersResponse["config"] | undefined;
    oraclePrices: OracleResponse["prices"] | undefined;
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

export function StatCards({ pool, config, oraclePrices, pair, isLoading }: StatCardsProps) {
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

    return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Mid Price" isLoading={isLoading}>
                {pool?.midPrice != null ? formatPrice(pool.midPrice, pair) : "—"}
            </StatCard>
            <StatCard label="Spread" isLoading={isLoading}>
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
            <StatCard label="Active Orders" isLoading={isLoading}>
                {pool?.orders.length ?? "—"}
            </StatCard>
            <StatCard label="Levels / Side" isLoading={isLoading}>
                {config?.levelsPerSide ?? "—"}
            </StatCard>
            <StatCard label={`Oracle ${oracle.base}`} isLoading={isLoading}>
                {oracle.basePrice ?? "—"}
            </StatCard>
            <StatCard label={`Oracle ${oracle.quote}`} isLoading={isLoading}>
                {oracle.quotePrice ?? "—"}
            </StatCard>
        </div>
    );
}

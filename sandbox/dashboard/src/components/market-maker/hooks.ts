import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import type { OrdersResponse, OracleResponse, PoolOrders, PoolDetailsView } from "./types";
import { useDeepBookClient, type ForkManifest } from "@/hooks/use-deepbook-client";
import { usePoolDetails as usePoolDetailsQuery, useForkManifest } from "@/components/trading/hooks";
import type { PoolKey } from "@/components/trading/types";
import {
    BOOK_COIN_SCALARS,
    FLOAT_SCALAR,
    coreOf,
    readBookLevels,
    forkRecentTrades,
    type ForkTrade,
} from "@/lib/fork";

export const REFETCH_INTERVAL = 3_000;
/** Book levels fetched/shown per side in fork mode (chain read). */
export const FORK_LEVELS_PER_SIDE = 10;
const TRADES_LIMIT = 30;

export { useForkManifest };
export type { ForkTrade };

/** The market-maker SERVICE's own orders API — localnet only (the service
 *  is retired on the fork stack; `enabled: false` there stops the page
 *  polling a dead proxy target every 3s). */
export function useMarketMakerOrders(enabled: boolean) {
    return useQuery<OrdersResponse>({
        queryKey: ["mm-orders"],
        queryFn: async () => {
            const r = await fetch("/api/mm/orders");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
        placeholderData: keepPreviousData,
        enabled,
    });
}

/**
 * Fork substitute for the MM orders feed: every pinned pool's book read
 * straight off the chain (readBookLevels — the server's /orderbook is
 * live-RPC, dead on the fork). One level = one `Order` row, so the existing
 * panels aggregate/render it unchanged. The book genuinely moves: trade-sim
 * re-quotes inside the spread every tick, and user orders rest here too.
 */
export function useForkBooks(fork: ForkManifest | null) {
    const suiClient = useCurrentClient();
    return useQuery<{ pools: PoolOrders[] }>({
        queryKey: ["fork-books"],
        queryFn: async () => {
            if (!fork) throw new Error("Not ready");
            const core = coreOf(suiClient);
            const pools: PoolOrders[] = [];
            for (const [key, pin] of Object.entries(fork.deepbook.pools)) {
                const book = await readBookLevels(core, pin, FORK_LEVELS_PER_SIDE).catch(() => ({
                    bids: [],
                    asks: [],
                }));
                const bestBid = book.bids[0]?.price;
                const bestAsk = book.asks[0]?.price;
                const mid =
                    bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : null;
                pools.push({
                    pair: key.replace("_", "/"),
                    poolId: pin.objectId,
                    midPrice: mid,
                    orders: [
                        ...book.bids.map((l) => ({
                            orderId: `bid-${l.price}`,
                            price: l.price,
                            quantity: l.quantity,
                            isBid: true,
                        })),
                        ...book.asks.map((l) => ({
                            orderId: `ask-${l.price}`,
                            price: l.price,
                            quantity: l.quantity,
                            isBid: false,
                        })),
                    ],
                });
            }
            return { pools };
        },
        refetchInterval: REFETCH_INTERVAL,
        placeholderData: keepPreviousData,
        enabled: !!fork,
    });
}

/**
 * Recent fills from the server's Postgres-backed /trades projection — works
 * on BOTH networks (indexer-fed, unlike the live-RPC group), and shows every
 * local fill regardless of who traded: trade-sim's self-fills and orders
 * executed from the trading page alike.
 */
export function useRecentTrades(poolKey: string) {
    return useQuery<ForkTrade[]>({
        queryKey: ["recent-trades", poolKey],
        queryFn: () => forkRecentTrades(poolKey, TRADES_LIMIT),
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
        placeholderData: keepPreviousData,
    });
}

/**
 * Pool details for the stat cards. The trading page's usePoolDetails is
 * devInspect-backed (midPrice / poolBookParams / getLevel2TicksFromMid) —
 * ALL dead on the fork (SUI-FORK-ISSUES #7) — so fork mode computes the
 * same view from the manifest pins + the measured book mid. Deliberately a
 * pure computation there, NOT a client-gated query: pool constants must not
 * need a connected wallet (the SDK client only exists with an account).
 */
export function usePoolDetails(
    poolKey: string,
    forkMidPrice: number | null,
): { data: PoolDetailsView | undefined; isLoading: boolean } {
    const { client } = useDeepBookClient();
    const fork = useForkManifest();
    const localnet = usePoolDetailsQuery(client, poolKey as PoolKey, !fork);
    if (fork) {
        const pin = fork.deepbook.pools[poolKey];
        if (!pin) return { data: undefined, isLoading: false };
        const [baseCoin, quoteCoin] = poolKey.split("_");
        const baseScalar = BOOK_COIN_SCALARS[baseCoin ?? ""] ?? 1_000_000;
        const quoteScalar = BOOK_COIN_SCALARS[quoteCoin ?? ""] ?? 1_000_000;
        return {
            data: {
                midPrice: forkMidPrice ?? 0,
                tickSize: (pin.tickSize * baseScalar) / quoteScalar / FLOAT_SCALAR,
                lotSize: pin.lotSize / baseScalar,
                minSize: pin.minSize / baseScalar,
            },
            isLoading: false,
        };
    }
    return { data: localnet.data, isLoading: localnet.isLoading };
}

/** The oracle SERVICE's price feed — localnet only (retired on the fork
 *  stack; the cards show em-dashes there). */
export function useOraclePrices(enabled: boolean) {
    return useQuery<OracleResponse>({
        queryKey: ["oracle-prices"],
        queryFn: async () => {
            const r = await fetch("/api/oracle/");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
        enabled,
    });
}

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { OrdersResponse, OracleResponse } from "./types";

export const REFETCH_INTERVAL = 3_000;

export function useMarketMakerOrders() {
    return useQuery<OrdersResponse>({
        queryKey: ["mm-orders"],
        queryFn: async () => {
            const r = await fetch("/api/mm/orders");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
        // Keep previous data visible while refetching so the chart doesn't
        // flash empty during market maker rebalance cycles.
        placeholderData: keepPreviousData,
    });
}

export interface PoolDetails {
    midPrice: string;
    tickSize: string;
    lotSize: string;
    minSize: string;
}

export function usePoolDetails(poolKey: string) {
    return useQuery<PoolDetails>({
        queryKey: ["pool-details", poolKey],
        queryFn: async () => {
            const r = await fetch(`/api/trading/pool-details/${poolKey}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (!data.success) throw new Error(data.error);
            return data as PoolDetails;
        },
        refetchInterval: 5_000,
        retry: false,
    });
}

export function useOraclePrices() {
    return useQuery<OracleResponse>({
        queryKey: ["oracle-prices"],
        queryFn: async () => {
            const r = await fetch("/api/oracle/");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        },
        refetchInterval: REFETCH_INTERVAL,
        retry: false,
    });
}

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

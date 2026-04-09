import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { OrdersResponse, OracleResponse } from "./types";
import { useDeepBookClient } from "@/hooks/use-deepbook-client";
import {
    usePoolDetails as usePoolDetailsQuery,
    type PoolDetails,
} from "@/components/trading/hooks";

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
        placeholderData: keepPreviousData,
    });
}

export { type PoolDetails };

export function usePoolDetails(poolKey: string) {
    const { client } = useDeepBookClient();
    return usePoolDetailsQuery(client, poolKey as "DEEP_SUI" | "SUI_USDC");
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

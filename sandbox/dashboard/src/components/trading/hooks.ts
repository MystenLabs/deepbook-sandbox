import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PoolKey, CoinKey, OrderDetail } from "./types";

const TRADING_API = "/api/faucet/trading";

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

async function tradingPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${TRADING_API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Request failed");
    return data as T;
}

/* ------------------------------------------------------------------ */
/*  useBalanceManager — BM lifecycle (create, deposit, withdraw)       */
/* ------------------------------------------------------------------ */

const BM_STORAGE_KEY = "trading-bm-id";

export function useBalanceManager() {
    const [balanceManagerId, setBalanceManagerId] = useState<string | null>(() =>
        localStorage.getItem(BM_STORAGE_KEY),
    );
    const queryClient = useQueryClient();

    const isSetup = !!balanceManagerId;

    const invalidateBalances = useMemo(
        () => () => {
            queryClient.invalidateQueries({ queryKey: ["bm-balances", balanceManagerId] });
            queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
        },
        [queryClient, balanceManagerId],
    );

    const create = useCallback(async () => {
        const result = await tradingPost<{ balanceManagerId: string; digest: string }>(
            "/create-balance-manager",
            {},
        );
        localStorage.setItem(BM_STORAGE_KEY, result.balanceManagerId);
        setBalanceManagerId(result.balanceManagerId);
        return result.balanceManagerId;
    }, []);

    const deposit = useCallback(
        async (coin: CoinKey, amount: number) => {
            if (!balanceManagerId) throw new Error("Balance manager not set up");
            const result = await tradingPost<{ digest: string }>("/deposit", {
                balanceManagerId,
                coin,
                amount,
            });
            invalidateBalances();
            return result.digest;
        },
        [balanceManagerId, invalidateBalances],
    );

    const withdraw = useCallback(
        async (coin: CoinKey, amount: number) => {
            if (!balanceManagerId) throw new Error("Balance manager not set up");
            const result = await tradingPost<{ digest: string }>("/withdraw", {
                balanceManagerId,
                coin,
                amount,
            });
            invalidateBalances();
            return result.digest;
        },
        [balanceManagerId, invalidateBalances],
    );

    return { balanceManagerId, isSetup, create, deposit, withdraw };
}

/* ------------------------------------------------------------------ */
/*  useWalletBalances — poll deployer wallet balances                   */
/* ------------------------------------------------------------------ */

export function useWalletBalances() {
    return useQuery<{ address: string; balances: Record<string, string> }>({
        queryKey: ["wallet-balances"],
        queryFn: async () => {
            const res = await fetch(`${TRADING_API}/wallet-balances`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            return { address: data.address, balances: data.balances };
        },
        refetchInterval: 5_000,
    });
}

/* ------------------------------------------------------------------ */
/*  useBmBalances — poll balance manager balances                      */
/* ------------------------------------------------------------------ */

export function useBmBalances(balanceManagerId: string | null) {
    return useQuery<Record<string, string>>({
        queryKey: ["bm-balances", balanceManagerId],
        queryFn: async () => {
            const res = await fetch(`${TRADING_API}/balances/${balanceManagerId}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            return data.balances;
        },
        enabled: !!balanceManagerId,
        refetchInterval: 5_000,
    });
}

/* ------------------------------------------------------------------ */
/*  useOpenOrders — poll open orders for a pool                        */
/* ------------------------------------------------------------------ */

export function useOpenOrders(poolKey: PoolKey, isSetup: boolean) {
    // For now, open orders are not queryable via the faucet API
    // (would need a read-only endpoint). Return empty array.
    // TODO: Add GET /trading/orders/:poolKey/:balanceManagerId endpoint
    return useQuery<OrderDetail[]>({
        queryKey: ["open-orders", poolKey],
        queryFn: async () => [],
        enabled: isSetup,
        refetchInterval: 5_000,
    });
}

/* ------------------------------------------------------------------ */
/*  useTrading — order placement and cancellation                      */
/* ------------------------------------------------------------------ */

export function useTrading(poolKey: PoolKey, balanceManagerId: string | null) {
    const queryClient = useQueryClient();

    const invalidateAll = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ["open-orders", poolKey] });
        queryClient.invalidateQueries({ queryKey: ["bm-balances", balanceManagerId] });
    }, [queryClient, poolKey, balanceManagerId]);

    const placeLimitOrder = useCallback(
        async (params: { price: number; quantity: number; isBid: boolean }) => {
            if (!balanceManagerId) throw new Error("Balance manager not set up");
            const result = await tradingPost<{ digest: string; orderId: string | null }>(
                "/limit-order",
                {
                    poolKey,
                    balanceManagerId,
                    price: params.price,
                    quantity: params.quantity,
                    isBid: params.isBid,
                },
            );
            invalidateAll();
            return result.digest;
        },
        [poolKey, balanceManagerId, invalidateAll],
    );

    const placeMarketOrder = useCallback(
        async (params: { quantity: number; isBid: boolean }) => {
            if (!balanceManagerId) throw new Error("Balance manager not set up");
            const result = await tradingPost<{ digest: string }>("/market-order", {
                poolKey,
                balanceManagerId,
                quantity: params.quantity,
                isBid: params.isBid,
            });
            invalidateAll();
            return result.digest;
        },
        [poolKey, balanceManagerId, invalidateAll],
    );

    const cancelOrder = useCallback(
        async (orderId: string) => {
            if (!balanceManagerId) throw new Error("Balance manager not set up");
            const result = await tradingPost<{ digest: string }>("/cancel-order", {
                poolKey,
                balanceManagerId,
                orderId,
            });
            invalidateAll();
            return result.digest;
        },
        [poolKey, balanceManagerId, invalidateAll],
    );

    const cancelAllOrders = useCallback(async () => {
        if (!balanceManagerId) throw new Error("Balance manager not set up");
        const result = await tradingPost<{ digest: string }>("/cancel-all", {
            poolKey,
            balanceManagerId,
        });
        invalidateAll();
        return result.digest;
    }, [poolKey, balanceManagerId, invalidateAll]);

    return { placeLimitOrder, placeMarketOrder, cancelOrder, cancelAllOrders };
}

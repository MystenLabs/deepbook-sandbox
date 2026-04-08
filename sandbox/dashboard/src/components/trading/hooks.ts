/**
 * Trading hooks — all operations use the DeepBook SDK directly.
 *
 * WRITE operations: build transaction with SDK, sign via Dev Wallet.
 * READ operations: query via SDK client (no backend API).
 * Only the BM ID and manifest come from the backend.
 */

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDAppKit, useCurrentClient } from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import type { Manifest, SandboxClient } from "@/hooks/use-deepbook-client";
import { BALANCE_MANAGER_KEY, buildPackageIds } from "@/hooks/use-deepbook-client";
import type { PoolKey, CoinKey, OrderDetail } from "./types";

/* ------------------------------------------------------------------ */
/*  READ hooks — direct SDK queries                                    */
/* ------------------------------------------------------------------ */

export function useWalletBalances(address: string | null) {
    const suiClient = useCurrentClient();
    return useQuery<{ address: string; balances: Record<string, string> }>({
        queryKey: ["wallet-balances", address],
        queryFn: async () => {
            if (!address) throw new Error("Not ready");
            const resp = await suiClient.listBalances({ owner: address });
            const balances: Record<string, string> = {};
            for (const b of resp.balances) {
                const name = b.coinType.split("::").pop() ?? b.coinType;
                const key = name.toUpperCase();
                const scalar = key === "SUI" ? 1_000_000_000 : 1_000_000;
                balances[key] = String(Number(b.balance) / scalar);
            }
            // Ensure all expected coins have a value
            for (const coin of ["SUI", "DEEP", "USDC"]) {
                if (!(coin in balances)) balances[coin] = "0";
            }
            return { address, balances };
        },
        enabled: !!address,
        refetchInterval: 10_000,
    });
}

export function useBmBalances(client: SandboxClient | null, balanceManagerId: string | null) {
    return useQuery<Record<string, string>>({
        queryKey: ["bm-balances", balanceManagerId],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            const coins = ["SUI", "DEEP", "USDC"];
            const results: Record<string, string> = {};
            for (const coin of coins) {
                try {
                    const { balance } = await client.deepbook.checkManagerBalance(
                        BALANCE_MANAGER_KEY,
                        coin,
                    );
                    results[coin] = String(balance);
                } catch {
                    results[coin] = "0";
                }
            }
            return results;
        },
        enabled: !!client && !!balanceManagerId,
        refetchInterval: 10_000,
    });
}

export function useMidPrice(client: SandboxClient | null, poolKey: PoolKey) {
    return useQuery<number>({
        queryKey: ["mid-price", poolKey],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            return client.deepbook.midPrice(poolKey);
        },
        enabled: !!client,
        refetchInterval: 10_000,
    });
}

export interface PoolParams {
    tickSize: number;
    lotSize: number;
    minSize: number;
}

export function usePoolParams(client: SandboxClient | null, poolKey: PoolKey) {
    return useQuery<PoolParams>({
        queryKey: ["pool-params", poolKey],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            return client.deepbook.poolBookParams(poolKey);
        },
        enabled: !!client,
        staleTime: 60_000,
    });
}

export function useOpenOrders(
    client: SandboxClient | null,
    poolKey: PoolKey,
    balanceManagerId: string | null,
) {
    return useQuery<OrderDetail[]>({
        queryKey: ["open-orders", poolKey, balanceManagerId],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            const raw = await client.deepbook.getAccountOrderDetails(poolKey, BALANCE_MANAGER_KEY);
            return raw.map((order) => {
                try {
                    const decoded = client.deepbook.decodeOrderId(BigInt(order.order_id));
                    return {
                        order_id: order.order_id,
                        client_order_id: order.client_order_id,
                        quantity: order.quantity,
                        filled_quantity: order.filled_quantity,
                        fee_is_deep: order.fee_is_deep,
                        status: String(order.status),
                        is_bid: decoded.isBid,
                        price: String(decoded.price),
                    } satisfies OrderDetail;
                } catch {
                    return {
                        order_id: order.order_id,
                        client_order_id: order.client_order_id,
                        quantity: order.quantity,
                        filled_quantity: order.filled_quantity,
                        fee_is_deep: order.fee_is_deep,
                        status: String(order.status),
                    } as OrderDetail;
                }
            });
        },
        enabled: !!client && !!balanceManagerId,
        refetchInterval: 10_000,
    });
}

export interface PoolDetails {
    midPrice: number;
    tickSize: number;
    lotSize: number;
    minSize: number;
    bid_prices: number[];
    bid_quantities: number[];
    ask_prices: number[];
    ask_quantities: number[];
}

export function usePoolDetails(client: SandboxClient | null, poolKey: PoolKey) {
    return useQuery<PoolDetails>({
        queryKey: ["pool-details", poolKey],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            const [midPrice, bookParams, depth] = await Promise.all([
                client.deepbook.midPrice(poolKey),
                client.deepbook.poolBookParams(poolKey),
                client.deepbook.getLevel2TicksFromMid(poolKey, 10),
            ]);
            return { midPrice, ...bookParams, ...depth };
        },
        enabled: !!client,
        refetchInterval: 10_000,
    });
}

/* ------------------------------------------------------------------ */
/*  WRITE hooks — wallet signing                                       */
/* ------------------------------------------------------------------ */

export function useTrading(
    client: SandboxClient | null,
    poolKey: PoolKey,
    withdrawAddress?: string | null,
) {
    const dAppKit = useDAppKit();
    const suiClient = useCurrentClient();
    const queryClient = useQueryClient();

    const invalidateAll = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ["open-orders"] });
        queryClient.invalidateQueries({ queryKey: ["bm-balances"] });
        queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
    }, [queryClient]);

    /** Wait for the chain to index the transaction, then invalidate caches. */
    const waitAndInvalidate = useCallback(
        async (digest: string) => {
            await suiClient.waitForTransaction({ digest });
            invalidateAll();
        },
        [suiClient, invalidateAll],
    );

    const deposit = useCallback(
        async (coin: CoinKey, amount: number) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            client.deepbook.balanceManager.depositIntoManager(
                BALANCE_MANAGER_KEY,
                coin,
                amount,
            )(tx);
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [client, dAppKit, waitAndInvalidate],
    );

    const withdraw = useCallback(
        async (coin: CoinKey, amount: number) => {
            if (!client || !withdrawAddress) throw new Error("SDK client not ready");
            const tx = new Transaction();
            client.deepbook.balanceManager.withdrawFromManager(
                BALANCE_MANAGER_KEY,
                coin,
                amount,
                withdrawAddress,
            )(tx);
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [client, withdrawAddress, dAppKit, waitAndInvalidate],
    );

    const placeLimitOrder = useCallback(
        async (params: { price: number; quantity: number; isBid: boolean }) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            client.deepbook.deepBook.placeLimitOrder({
                poolKey,
                balanceManagerKey: BALANCE_MANAGER_KEY,
                clientOrderId: String(Date.now()),
                price: params.price,
                quantity: params.quantity,
                isBid: params.isBid,
                orderType: OrderType.NO_RESTRICTION,
                selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
                payWithDeep: false,
            })(tx);
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [client, poolKey, dAppKit, waitAndInvalidate],
    );

    const placeMarketOrder = useCallback(
        async (params: { quantity: number; isBid: boolean }) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            client.deepbook.deepBook.placeMarketOrder({
                poolKey,
                balanceManagerKey: BALANCE_MANAGER_KEY,
                clientOrderId: String(Date.now()),
                quantity: params.quantity,
                isBid: params.isBid,
                selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
                payWithDeep: false,
            })(tx);
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [client, poolKey, dAppKit, waitAndInvalidate],
    );

    const cancelOrder = useCallback(
        async (orderId: string) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            client.deepbook.deepBook.cancelOrder(poolKey, BALANCE_MANAGER_KEY, orderId)(tx);
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [client, poolKey, dAppKit, waitAndInvalidate],
    );

    const cancelAllOrders = useCallback(async () => {
        if (!client) throw new Error("SDK client not ready");
        const tx = new Transaction();
        client.deepbook.deepBook.cancelAllOrders(poolKey, BALANCE_MANAGER_KEY)(tx);
        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        await waitAndInvalidate(result.Transaction!.digest);
        return result.Transaction!.digest;
    }, [client, poolKey, dAppKit, invalidateAll]);

    return { deposit, withdraw, placeLimitOrder, placeMarketOrder, cancelOrder, cancelAllOrders };
}

/**
 * Create a BalanceManager for the connected wallet.
 *
 * Bundles three moveCalls in a single PTB:
 *   1. SDK helper `createBalanceManagerWithOwner` — creates the BM, returns ref
 *   2. raw `register_balance_manager`            — records owner→BM in registry
 *   3. SDK helper `shareBalanceManager`          — shares the BM publicly
 *
 * The middle step is a raw moveCall because the SDK's `registerBalanceManager`
 * helper takes a `managerKey` (a config lookup), not a fresh `TransactionArgument`,
 * so it can't be chained with a just-created BM in the same PTB.
 *
 * After the tx settles, invalidates the BM discovery query so the dashboard
 * picks up the new BM and unlocks the trading UI.
 */
export function useCreateBalanceManager(
    client: SandboxClient | null,
    manifest: Manifest | null,
    address: string | null,
) {
    const dAppKit = useDAppKit();
    const suiClient = useCurrentClient();
    const queryClient = useQueryClient();

    return useCallback(async () => {
        if (!client || !manifest || !address) throw new Error("Not ready");

        const pkgIds = buildPackageIds(manifest);
        const deepbookPkgId = pkgIds.DEEPBOOK_PACKAGE_ID;
        const registryId = pkgIds.REGISTRY_ID;
        if (!deepbookPkgId || !registryId) {
            throw new Error("Manifest missing deepbook package id or registry id");
        }

        const tx = new Transaction();

        const bm = client.deepbook.balanceManager.createBalanceManagerWithOwner(address)(tx);

        tx.moveCall({
            target: `${deepbookPkgId}::balance_manager::register_balance_manager`,
            arguments: [bm, tx.object(registryId)],
        });

        client.deepbook.balanceManager.shareBalanceManager(bm)(tx);

        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        if (result.$kind === "FailedTransaction") {
            throw new Error(result.FailedTransaction.status.error?.message ?? "Transaction failed");
        }
        await suiClient.waitForTransaction({ digest: result.Transaction!.digest });
        queryClient.invalidateQueries({ queryKey: ["balance-manager-id"] });
        return result.Transaction!.digest;
    }, [client, manifest, address, dAppKit, suiClient, queryClient]);
}

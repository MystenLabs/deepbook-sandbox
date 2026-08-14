/**
 * Trading hooks — all operations use the DeepBook SDK directly.
 *
 * WRITE operations: build transaction with SDK, sign via Dev Wallet (dapp-kit).
 * READ operations: query via SDK client (no backend API).
 *
 * Sources of truth:
 *   - Manifest (deepbook package + registry IDs, pools, coin types):
 *     fetched once from `/api/manifest` and cached for the session.
 *   - User's BalanceManager: discovered on-chain via
 *     `client.deepbook.getBalanceManagerIds(address)`, which reads the
 *     deepbook Registry's owner→BM map. No env var, no localStorage,
 *     no backend lookup.
 *   - Wallet balances, BM balances, mid price, open orders: live SDK queries.
 */

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDAppKit, useCurrentClient } from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import type { ForkManifest, Manifest, SandboxClient } from "@/hooks/use-deepbook-client";
import {
    BALANCE_MANAGER_KEY,
    buildPackageIds,
    isForkManifest,
    useManifest,
} from "@/hooks/use-deepbook-client";
import {
    FLOAT_SCALAR,
    coreOf,
    forkBmBalance,
    forkCancelAllOrders,
    forkCancelOrder,
    forkDeposit,
    forkLastPrice,
    forkOpenOrders,
    forkPlaceLimitOrder,
    forkPlaceMarketOrder,
    forkWithdraw,
    listOwnedCoins,
    setForkGas,
} from "@/lib/fork";
import type { PoolKey, CoinKey, OrderDetail } from "./types";

const COIN_SCALARS: Record<string, number> = {
    SUI: 1_000_000_000,
    DEEP: 1_000_000,
    USDC: 1_000_000,
};
const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

/** Fork-mode branch info for the hooks (react-query dedupes the manifest
 *  fetch with useDeepBookClient's). null = localnet / not loaded yet. */
function useForkManifest(): ForkManifest | null {
    const manifest = useManifest();
    return manifest.data && isForkManifest(manifest.data) ? manifest.data : null;
}

const forkCoinType = (fork: ForkManifest, coin: string): string => {
    if (coin === "SUI") return SUI_TYPE;
    if (coin === "DEEP") return fork.deepbook.pools.DEEP_SUI.baseType;
    return fork.deepbook.pools.SUI_USDC.quoteType;
};

/** Fork execution is final when the response lands; waiting only serves the
 *  indexer, so a hiccup there must not fail the whole action. */
async function waitBestEffort(
    suiClient: {
        waitForTransaction: (args: { digest: string; signal?: AbortSignal }) => Promise<unknown>;
    },
    digest: string,
): Promise<void> {
    try {
        await suiClient.waitForTransaction({ digest, signal: AbortSignal.timeout(5_000) });
    } catch {
        /* already final on-chain */
    }
}

/* ------------------------------------------------------------------ */
/*  READ hooks — direct SDK queries                                    */
/* ------------------------------------------------------------------ */

export function useWalletBalances(address: string | null) {
    const suiClient = useCurrentClient();
    const fork = useForkManifest();
    return useQuery<{ address: string; balances: Record<string, string> }>({
        queryKey: ["wallet-balances", address, !!fork],
        queryFn: async () => {
            if (!address) throw new Error("Not ready");
            const balances: Record<string, string> = {};
            if (fork) {
                // The fork has no balance index — enumerate owned (fork-local)
                // coins and read balances from their content.
                const coins = await listOwnedCoins(coreOf(suiClient), address);
                const totals = new Map<string, bigint>();
                for (const c of coins) {
                    const key = (c.coinType.split("::").pop() ?? c.coinType).toUpperCase();
                    totals.set(key, (totals.get(key) ?? 0n) + c.balance);
                }
                for (const [key, total] of totals) {
                    const scalar = COIN_SCALARS[key] ?? 1_000_000;
                    balances[key] = String(Number(total) / scalar);
                }
            } else {
                const resp = await suiClient.listBalances({ owner: address });
                for (const b of resp.balances) {
                    const name = b.coinType.split("::").pop() ?? b.coinType;
                    const key = name.toUpperCase();
                    const scalar = key === "SUI" ? 1_000_000_000 : 1_000_000;
                    balances[key] = String(Number(b.balance) / scalar);
                }
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
    const suiClient = useCurrentClient();
    const fork = useForkManifest();
    return useQuery<Record<string, string>>({
        queryKey: ["bm-balances", balanceManagerId, !!fork],
        queryFn: async () => {
            if (!client || !balanceManagerId) throw new Error("Not ready");
            const coins = ["SUI", "DEEP", "USDC"];
            const results: Record<string, string> = {};
            for (const coin of coins) {
                try {
                    if (fork) {
                        // checkManagerBalance simulates; read the manager's Bag
                        // dynamic field directly instead.
                        const raw = await forkBmBalance(
                            coreOf(suiClient),
                            balanceManagerId,
                            fork.deepbook.packages.deepbook.originalId,
                            forkCoinType(fork, coin),
                        );
                        results[coin] = String(Number(raw) / (COIN_SCALARS[coin] ?? 1_000_000));
                    } else {
                        const { balance } = await client.deepbook.checkManagerBalance(
                            BALANCE_MANAGER_KEY,
                            coin,
                        );
                        results[coin] = String(balance);
                    }
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
    const fork = useForkManifest();
    return useQuery<number>({
        queryKey: ["mid-price", poolKey, !!fork],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            // Fork: no simulation ⇒ no on-chain mid; the server's last fill
            // price is the sandbox's price view (trade-sim keeps it live).
            if (fork) return forkLastPrice(poolKey);
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
    const fork = useForkManifest();
    return useQuery<PoolParams>({
        queryKey: ["pool-params", poolKey, !!fork],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            if (fork) {
                // The raw params are pinned in the fork manifest; convert with
                // the SDK's poolBookParams formulas (FLOAT_SCALAR = 1e9).
                const pool = fork.deepbook.pools[poolKey];
                if (!pool) throw new Error(`pool ${poolKey} not in the fork manifest`);
                const [baseCoin, quoteCoin] = poolKey.split("_");
                const baseScalar = COIN_SCALARS[baseCoin ?? ""] ?? 1_000_000;
                const quoteScalar = COIN_SCALARS[quoteCoin ?? ""] ?? 1_000_000;
                return {
                    tickSize: (pool.tickSize * baseScalar) / quoteScalar / FLOAT_SCALAR,
                    lotSize: pool.lotSize / baseScalar,
                    minSize: pool.minSize / baseScalar,
                };
            }
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
    const fork = useForkManifest();
    return useQuery<OrderDetail[]>({
        queryKey: ["open-orders", poolKey, balanceManagerId, !!fork],
        queryFn: async () => {
            if (!client) throw new Error("Not ready");
            if (fork) {
                // getAccountOrderDetails simulates; the indexer's order_updates
                // projection (server /orders) carries the same view. The
                // client_order_id is not indexed — the UI tolerates "".
                if (!balanceManagerId) return [];
                const orders = await forkOpenOrders(poolKey, balanceManagerId);
                return orders.map((o): OrderDetail => ({
                    order_id: String(o.order_id),
                    client_order_id: "",
                    quantity: String(o.original_quantity),
                    filled_quantity: String(o.filled_quantity),
                    fee_is_deep: false,
                    status: o.current_status,
                    is_bid: o.type === "buy",
                    price: String(o.price),
                }));
            }
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
    balanceManagerId?: string | null,
) {
    const dAppKit = useDAppKit();
    const suiClient = useCurrentClient();
    const queryClient = useQueryClient();
    const fork = useForkManifest();

    const invalidateAll = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ["open-orders"] });
        queryClient.invalidateQueries({ queryKey: ["bm-balances"] });
        queryClient.invalidateQueries({ queryKey: ["wallet-balances"] });
    }, [queryClient]);

    /** Wait for the chain to index the transaction, then invalidate caches.
     *  On the fork the wait is best-effort — execution is already final. */
    const waitAndInvalidate = useCallback(
        async (digest: string) => {
            if (fork) await waitBestEffort(suiClient, digest);
            else await suiClient.waitForTransaction({ digest });
            invalidateAll();
        },
        [suiClient, invalidateAll, fork],
    );

    /** Fork txs carry explicit gas so building never dry-runs (the fork has
     *  no simulate_transaction) and never consults the dead coin index. */
    const prepareGas = useCallback(
        async (tx: Transaction) => {
            if (!fork || !withdrawAddress) return;
            await setForkGas(coreOf(suiClient), tx, withdrawAddress);
        },
        [fork, suiClient, withdrawAddress],
    );

    /** Common args for the raw fork order builders (the SDK thunks reference
     *  objects via unresolved tx.object(id) inputs, whose build-time
     *  resolution rides simulateTransaction — unavailable on the fork). */
    const forkOrderCommon = useCallback(() => {
        if (!fork) throw new Error("Not in fork mode");
        if (!balanceManagerId) throw new Error("No BalanceManager");
        const pool = fork.deepbook.pools[poolKey];
        if (!pool) throw new Error(`pool ${poolKey} missing from the fork manifest`);
        return {
            deepbookPackageId: fork.deepbook.packages.deepbook.latestId,
            pool,
            balanceManagerId,
        };
    }, [fork, poolKey, balanceManagerId]);

    const poolScalars = useCallback(() => {
        const [baseSym, quoteSym] = poolKey.split("_");
        return {
            baseScalar: COIN_SCALARS[baseSym ?? ""] ?? 1_000_000,
            quoteScalar: COIN_SCALARS[quoteSym ?? ""] ?? 1_000_000,
        };
    }, [poolKey]);

    const deposit = useCallback(
        async (coin: CoinKey, amount: number) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            if (fork) {
                // The SDK thunk's coinWithBalance intent resolves through the
                // coin index — dead on the fork. Build the deposit from
                // enumerable owned coins instead (SUI splits from gas).
                if (!withdrawAddress) throw new Error("No wallet address");
                if (!balanceManagerId) throw new Error("No BalanceManager");
                await forkDeposit(coreOf(suiClient), tx, {
                    sender: withdrawAddress,
                    deepbookPackageId: fork.deepbook.packages.deepbook.latestId,
                    balanceManagerId,
                    coinType: forkCoinType(fork, coin),
                    amount: BigInt(Math.round(amount * (COIN_SCALARS[coin] ?? 1_000_000))),
                });
                await prepareGas(tx);
            } else {
                client.deepbook.balanceManager.depositIntoManager(
                    BALANCE_MANAGER_KEY,
                    coin,
                    amount,
                )(tx);
            }
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [
            client,
            dAppKit,
            waitAndInvalidate,
            fork,
            suiClient,
            withdrawAddress,
            balanceManagerId,
            prepareGas,
        ],
    );

    const withdraw = useCallback(
        async (coin: CoinKey, amount: number) => {
            if (!client || !withdrawAddress) throw new Error("SDK client not ready");
            const tx = new Transaction();
            if (fork) {
                if (!balanceManagerId) throw new Error("No BalanceManager");
                await forkWithdraw(coreOf(suiClient), tx, {
                    deepbookPackageId: fork.deepbook.packages.deepbook.latestId,
                    balanceManagerId,
                    coinType: forkCoinType(fork, coin),
                    amount: BigInt(Math.round(amount * (COIN_SCALARS[coin] ?? 1_000_000))),
                    recipient: withdrawAddress,
                });
                await prepareGas(tx);
            } else {
                client.deepbook.balanceManager.withdrawFromManager(
                    BALANCE_MANAGER_KEY,
                    coin,
                    amount,
                    withdrawAddress,
                )(tx);
            }
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [
            client,
            withdrawAddress,
            dAppKit,
            waitAndInvalidate,
            prepareGas,
            fork,
            suiClient,
            balanceManagerId,
        ],
    );

    const placeLimitOrder = useCallback(
        async (params: { price: number; quantity: number; isBid: boolean }) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            if (fork) {
                const { baseScalar, quoteScalar } = poolScalars();
                await forkPlaceLimitOrder(coreOf(suiClient), tx, {
                    ...forkOrderCommon(),
                    clientOrderId: String(Date.now()),
                    priceRaw: BigInt(
                        Math.round((params.price * FLOAT_SCALAR * quoteScalar) / baseScalar),
                    ),
                    quantityRaw: BigInt(Math.round(params.quantity * baseScalar)),
                    isBid: params.isBid,
                });
                await prepareGas(tx);
            } else {
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
            }
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [
            client,
            poolKey,
            dAppKit,
            waitAndInvalidate,
            prepareGas,
            fork,
            suiClient,
            forkOrderCommon,
            poolScalars,
        ],
    );

    const placeMarketOrder = useCallback(
        async (params: { quantity: number; isBid: boolean }) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            if (fork) {
                const { baseScalar } = poolScalars();
                await forkPlaceMarketOrder(coreOf(suiClient), tx, {
                    ...forkOrderCommon(),
                    clientOrderId: String(Date.now()),
                    quantityRaw: BigInt(Math.round(params.quantity * baseScalar)),
                    isBid: params.isBid,
                });
                await prepareGas(tx);
            } else {
                client.deepbook.deepBook.placeMarketOrder({
                    poolKey,
                    balanceManagerKey: BALANCE_MANAGER_KEY,
                    clientOrderId: String(Date.now()),
                    quantity: params.quantity,
                    isBid: params.isBid,
                    selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
                    payWithDeep: false,
                })(tx);
            }
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [
            client,
            poolKey,
            dAppKit,
            waitAndInvalidate,
            prepareGas,
            fork,
            suiClient,
            forkOrderCommon,
            poolScalars,
        ],
    );

    const cancelOrder = useCallback(
        async (orderId: string) => {
            if (!client) throw new Error("SDK client not ready");
            const tx = new Transaction();
            if (fork) {
                await forkCancelOrder(coreOf(suiClient), tx, {
                    ...forkOrderCommon(),
                    orderId,
                });
                await prepareGas(tx);
            } else {
                client.deepbook.deepBook.cancelOrder(poolKey, BALANCE_MANAGER_KEY, orderId)(tx);
            }
            const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
            await waitAndInvalidate(result.Transaction!.digest);
            return result.Transaction!.digest;
        },
        [client, poolKey, dAppKit, waitAndInvalidate, prepareGas, fork, suiClient, forkOrderCommon],
    );

    const cancelAllOrders = useCallback(async () => {
        if (!client) throw new Error("SDK client not ready");
        const tx = new Transaction();
        if (fork) {
            await forkCancelAllOrders(coreOf(suiClient), tx, forkOrderCommon());
            await prepareGas(tx);
        } else {
            client.deepbook.deepBook.cancelAllOrders(poolKey, BALANCE_MANAGER_KEY)(tx);
        }
        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        await waitAndInvalidate(result.Transaction!.digest);
        return result.Transaction!.digest;
    }, [client, poolKey, dAppKit, waitAndInvalidate, prepareGas, fork, suiClient, forkOrderCommon]);

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

        // Fork: reference the registry by its pinned initial shared version so
        // building needs no object resolution, and set explicit gas (the fork
        // can neither dry-run nor gas-select).
        let registryArg;
        if (isForkManifest(manifest)) {
            registryArg = tx.sharedObjectRef({
                objectId: registryId,
                initialSharedVersion: String(manifest.deepbook.registry.initialSharedVersion),
                mutable: true,
            });
        } else {
            registryArg = tx.object(registryId);
        }

        tx.moveCall({
            target: `${deepbookPkgId}::balance_manager::register_balance_manager`,
            arguments: [bm, registryArg],
        });

        client.deepbook.balanceManager.shareBalanceManager(bm)(tx);
        if (isForkManifest(manifest)) {
            await setForkGas(coreOf(suiClient), tx, address);
        }

        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        if (result.$kind === "FailedTransaction") {
            throw new Error(result.FailedTransaction.status.error?.message ?? "Transaction failed");
        }
        if (isForkManifest(manifest)) {
            await waitBestEffort(suiClient, result.Transaction!.digest);
        } else {
            await suiClient.waitForTransaction({ digest: result.Transaction!.digest });
        }
        queryClient.invalidateQueries({ queryKey: ["balance-manager-id"] });
        return result.Transaction!.digest;
    }, [client, manifest, address, dAppKit, suiClient, queryClient]);
}

/**
 * Shared DeepBook SDK client hook.
 *
 * Builds a client from the deployment manifest + connected wallet address.
 * The BM ID is fetched from the backend (set by deploy-all).
 * All SDK queries and transaction building use this client.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { deepbook, type DeepBookClient } from "@mysten/deepbook-v3";
import type { CoinMap, PoolMap, DeepbookPackageIds, BalanceManager } from "@mysten/deepbook-v3";
import type { ClientWithExtensions } from "@mysten/sui/client";

export type SandboxClient = ClientWithExtensions<{ deepbook: DeepBookClient }>;

const SUI_FRAMEWORK = "0x0000000000000000000000000000000000000000000000000000000000000002";
export const BALANCE_MANAGER_KEY = "MANAGER_1";

/* ------------------------------------------------------------------ */
/*  Manifest types                                                     */
/* ------------------------------------------------------------------ */

interface ManifestPackage {
    packageId: string;
    objects: Array<{ objectId: string; objectType: string }>;
}

interface ManifestPool {
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
}

export interface Manifest {
    packages: Record<string, ManifestPackage>;
    pools: Record<string, ManifestPool>;
    deployerAddress: string;
}

/* ------------------------------------------------------------------ */
/*  SDK config builders                                                */
/* ------------------------------------------------------------------ */

function findObject(objects: ManifestPackage["objects"], match: string, exclude?: string): string {
    const obj = objects.find(
        (o) => o.objectType.includes(match) && (!exclude || !o.objectType.includes(exclude)),
    );
    if (!obj) throw new Error(`Object matching "${match}" not found`);
    return obj.objectId;
}

function buildPackageIds(m: Manifest): DeepbookPackageIds {
    return {
        DEEPBOOK_PACKAGE_ID: m.packages.deepbook.packageId,
        REGISTRY_ID: findObject(m.packages.deepbook.objects, "Registry", "MarginRegistry"),
        DEEP_TREASURY_ID: findObject(m.packages.token.objects, "ProtectedTreasury"),
    };
}

function buildCoinMap(m: Manifest): CoinMap {
    return {
        DEEP: {
            address: m.packages.token.packageId,
            type: m.pools.DEEP_SUI.baseCoinType,
            scalar: 1_000_000,
        },
        SUI: {
            address: SUI_FRAMEWORK,
            type: `${SUI_FRAMEWORK}::sui::SUI`,
            scalar: 1_000_000_000,
        },
        USDC: {
            address: m.packages.usdc.packageId,
            type: m.pools.SUI_USDC.quoteCoinType,
            scalar: 1_000_000,
        },
    };
}

function buildPoolMap(m: Manifest): PoolMap {
    return {
        DEEP_SUI: { address: m.pools.DEEP_SUI.poolId, baseCoin: "DEEP", quoteCoin: "SUI" },
        SUI_USDC: { address: m.pools.SUI_USDC.poolId, baseCoin: "SUI", quoteCoin: "USDC" },
    };
}

/* ------------------------------------------------------------------ */
/*  Data fetching hooks                                                */
/* ------------------------------------------------------------------ */

export function useManifest() {
    return useQuery<Manifest>({
        queryKey: ["deployment-manifest"],
        queryFn: async () => {
            const r = await fetch("/api/manifest");
            if (!r.ok) throw new Error("Manifest not found");
            return r.json();
        },
        staleTime: Infinity,
    });
}

export function useBalanceManagerId() {
    return useQuery<string | null>({
        queryKey: ["balance-manager-id"],
        queryFn: async () => {
            const r = await fetch("/api/trading/balance-manager");
            const data = await r.json();
            if (!data.success) throw new Error(data.error);
            return data.balanceManagerId ?? null;
        },
        staleTime: 60_000,
    });
}

/* ------------------------------------------------------------------ */
/*  Main hook                                                          */
/* ------------------------------------------------------------------ */

export function useDeepBookClient() {
    const suiClient = useCurrentClient();
    const account = useCurrentAccount();
    const manifest = useManifest();
    const bmQuery = useBalanceManagerId();

    const balanceManagerId = bmQuery.data ?? null;

    const client = useMemo(() => {
        if (!account?.address || !manifest.data) return null;

        const balanceManagers: Record<string, BalanceManager> | undefined = balanceManagerId
            ? { [BALANCE_MANAGER_KEY]: { address: balanceManagerId } }
            : undefined;

        try {
            return (
                suiClient as unknown as {
                    $extend: (reg: ReturnType<typeof deepbook>) => SandboxClient;
                }
            ).$extend(
                deepbook({
                    address: account.address,
                    packageIds: buildPackageIds(manifest.data),
                    coins: buildCoinMap(manifest.data),
                    pools: buildPoolMap(manifest.data),
                    balanceManagers,
                }),
            );
        } catch (err) {
            console.error("Failed to create DeepBook client:", err);
            return null;
        }
    }, [suiClient, account?.address, manifest.data, balanceManagerId]);

    return {
        client,
        isReady: !!client,
        address: account?.address ?? null,
        balanceManagerId,
        isSetup: !!balanceManagerId,
        manifestLoading: manifest.isLoading,
    };
}

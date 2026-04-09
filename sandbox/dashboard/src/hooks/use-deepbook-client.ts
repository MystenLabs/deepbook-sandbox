/**
 * Shared DeepBook SDK client hook.
 *
 * Builds a client from the deployment manifest + connected wallet address.
 * The BM ID is discovered on-chain via `client.deepbook.getBalanceManagerIds`,
 * which reads the deepbook Registry's owner→IDs map. No backend storage —
 * the chain is the source of truth.
 *
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

/**
 * Locate an object whose type name matches `typeName` exactly at the end of
 * the type string (i.e. `…::typeName` or `…::typeName<…>`). Substring matching
 * is dangerous: e.g. "Registry" would otherwise match `RegistryInner` and the
 * `dynamic_field::Field<u64, RegistryInner>` child object that gets emitted
 * during package init — which then fails as a PTB input because it's owned by
 * the Versioned wrapper, not by an address.
 */
function findObject(
    objects: ManifestPackage["objects"],
    typeName: string,
    exclude?: string,
): string {
    const pattern = new RegExp(`::${typeName}(?:<|$)`);
    const obj = objects.find(
        (o) => pattern.test(o.objectType) && (!exclude || !o.objectType.includes(exclude)),
    );
    if (!obj) throw new Error(`Object matching "${typeName}" not found`);
    return obj.objectId;
}

export function buildPackageIds(m: Manifest): DeepbookPackageIds {
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

function useManifest() {
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

/* ------------------------------------------------------------------ */
/*  Main hook                                                          */
/* ------------------------------------------------------------------ */

function buildClient(
    suiClient: ReturnType<typeof useCurrentClient>,
    address: string,
    manifestData: Manifest,
    balanceManagerId: string | null,
): SandboxClient | null {
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
                address,
                packageIds: buildPackageIds(manifestData),
                coins: buildCoinMap(manifestData),
                pools: buildPoolMap(manifestData),
                balanceManagers,
            }),
        );
    } catch (err) {
        console.error("Failed to create DeepBook client:", err);
        return null;
    }
}

export function useDeepBookClient() {
    const suiClient = useCurrentClient();
    const account = useCurrentAccount();
    const manifest = useManifest();

    // Bare client (no BM in config) — used to drive the discovery query.
    // Cheap to build, just a config wrapper around the underlying suiClient.
    const bareClient = useMemo(() => {
        if (!account?.address || !manifest.data) return null;
        return buildClient(suiClient, account.address, manifest.data, null);
    }, [suiClient, account?.address, manifest.data]);

    // Discover the user's BM via the on-chain registry. Returns the first
    // BM ID owned by the connected address, or null if none registered yet.
    const bmQuery = useQuery<string | null>({
        queryKey: ["balance-manager-id", account?.address ?? null],
        queryFn: async () => {
            if (!bareClient || !account?.address) return null;
            const ids = await bareClient.deepbook.getBalanceManagerIds(account.address);
            return ids[0] ?? null;
        },
        enabled: !!bareClient && !!account?.address,
        staleTime: 60_000,
    });

    const balanceManagerId = bmQuery.data ?? null;

    // Full client — has the BM in config if discovery found one.
    const client = useMemo(() => {
        if (!account?.address || !manifest.data) return null;
        return buildClient(suiClient, account.address, manifest.data, balanceManagerId);
    }, [suiClient, account?.address, manifest.data, balanceManagerId]);

    return {
        client,
        isReady: !!client,
        address: account?.address ?? null,
        balanceManagerId,
        isSetup: !!balanceManagerId,
        manifest: manifest.data ?? null,
        manifestLoading: manifest.isLoading,
    };
}

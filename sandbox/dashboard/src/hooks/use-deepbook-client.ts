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

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { deepbook, type DeepBookClient } from "@mysten/deepbook-v3";
import type { CoinMap, PoolMap, DeepbookPackageIds, BalanceManager } from "@mysten/deepbook-v3";
import type { ClientWithExtensions } from "@mysten/sui/client";
import { coreOf, forkBalanceManagerIds } from "@/lib/fork";

export type SandboxClient = ClientWithExtensions<{ deepbook: DeepBookClient }>;

const SUI_FRAMEWORK = "0x0000000000000000000000000000000000000000000000000000000000000002";
export const BALANCE_MANAGER_KEY = "MANAGER_1";

/** Mainnet DEEP ProtectedTreasury — a fixed mainnet object the fork inherits
 *  (mirrors @mysten/deepbook-v3's mainnetPackageIds.DEEP_TREASURY_ID). */
const MAINNET_DEEP_TREASURY_ID =
    "0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe";

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

/** The localnet deploy-all manifest (deployments/localnet.json). */
export interface LocalnetManifest {
    packages: Record<string, ManifestPackage>;
    pools: Record<string, ManifestPool>;
    deployerAddress: string;
    /** Mainnet DEEP donor impersonated on a fork; see deployments/fork-impersonation.md. */
    deepDonorAddress?: string;
}

/** The mainnet-fork id-pin manifest (deployments/mainnet-fork.json, DBSF-016)
 *  — the shape sandbox-api serves in fork mode. */
export interface ForkManifest {
    network: { type: string; upstream?: string };
    deepbook: {
        packages: Record<string, { originalId: string; latestId: string }>;
        registry: { objectId: string; initialSharedVersion: string | number };
        adminWallet: string;
        pools: Record<
            string,
            {
                objectId: string;
                initialSharedVersion: string | number;
                baseType: string;
                quoteType: string;
                tickSize: number;
                lotSize: number;
                minSize: number;
            }
        >;
    };
}

export type Manifest = LocalnetManifest | ForkManifest;

export function isForkManifest(m: Manifest): m is ForkManifest {
    return (m as ForkManifest).network?.type === "fork";
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
    if (isForkManifest(m)) {
        return {
            // moveCalls target the LATEST package; event/dynamic-field type
            // tags carry the ORIGINAL id (the fork read helpers handle that).
            DEEPBOOK_PACKAGE_ID: m.deepbook.packages.deepbook.latestId,
            REGISTRY_ID: m.deepbook.registry.objectId,
            DEEP_TREASURY_ID: MAINNET_DEEP_TREASURY_ID,
        };
    }
    return {
        DEEPBOOK_PACKAGE_ID: m.packages.deepbook.packageId,
        REGISTRY_ID: findObject(m.packages.deepbook.objects, "Registry", "MarginRegistry"),
        DEEP_TREASURY_ID: findObject(m.packages.token.objects, "ProtectedTreasury"),
    };
}

const addressOfType = (coinType: string): string => coinType.split("::")[0] ?? coinType;

function buildCoinMap(m: Manifest): CoinMap {
    if (isForkManifest(m)) {
        const deepType = m.deepbook.pools.DEEP_SUI.baseType;
        const usdcType = m.deepbook.pools.SUI_USDC.quoteType;
        return {
            DEEP: { address: addressOfType(deepType), type: deepType, scalar: 1_000_000 },
            SUI: {
                address: SUI_FRAMEWORK,
                type: `${SUI_FRAMEWORK}::sui::SUI`,
                scalar: 1_000_000_000,
            },
            USDC: { address: addressOfType(usdcType), type: usdcType, scalar: 1_000_000 },
        };
    }
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
    if (isForkManifest(m)) {
        return {
            DEEP_SUI: {
                address: m.deepbook.pools.DEEP_SUI.objectId,
                baseCoin: "DEEP",
                quoteCoin: "SUI",
            },
            SUI_USDC: {
                address: m.deepbook.pools.SUI_USDC.objectId,
                baseCoin: "SUI",
                quoteCoin: "USDC",
            },
        };
    }
    return {
        DEEP_SUI: { address: m.pools.DEEP_SUI.poolId, baseCoin: "DEEP", quoteCoin: "SUI" },
        SUI_USDC: { address: m.pools.SUI_USDC.poolId, baseCoin: "SUI", quoteCoin: "USDC" },
    };
}

/* ------------------------------------------------------------------ */
/*  Data fetching hooks                                                */
/* ------------------------------------------------------------------ */

/** Exported so the trading hooks can branch on fork mode without threading
 *  the manifest through every component (react-query dedupes the fetch). */
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

/* ------------------------------------------------------------------ */
/*  Which discovered BalanceManager to trade with                      */
/* ------------------------------------------------------------------ */

/**
 * Discovery stays on-chain (the registry's owner→BM map); this is only a
 * per-wallet PREFERENCE for which of the discovered ids the page trades with.
 * It exists because a manager's Bag entry can go permanently unreadable on
 * the fork (SUI-FORK-ISSUES #10): deposits of that coin vanish and every sell
 * aborts, with no way to detect it by reading, so the user needs to abandon
 * that manager for another one. Shared through a module-level store so every
 * `useDeepBookClient` instance (the trading page, the market-maker page's
 * client) agrees on the selection.
 */
const BM_SELECTION_KEY = "deepbook-sandbox:selected-bm";

type BmSelections = Record<string, string>;

const readSelections = (): BmSelections => {
    try {
        const raw = localStorage.getItem(BM_SELECTION_KEY);
        return raw ? (JSON.parse(raw) as BmSelections) : {};
    } catch {
        return {}; // private mode / corrupt value — fall back to the default pick
    }
};

let selections: BmSelections = readSelections();
const selectionListeners = new Set<() => void>();

const subscribeSelections = (listener: () => void): (() => void) => {
    selectionListeners.add(listener);
    return () => selectionListeners.delete(listener);
};
/** Stable reference unless a selection actually changes (useSyncExternalStore). */
const selectionsSnapshot = (): BmSelections => selections;

function storeSelection(address: string, balanceManagerId: string): void {
    if (selections[address] === balanceManagerId) return;
    selections = { ...selections, [address]: balanceManagerId };
    try {
        localStorage.setItem(BM_SELECTION_KEY, JSON.stringify(selections));
    } catch {
        /* preference is best-effort; the in-memory store still works */
    }
    selectionListeners.forEach((listener) => listener());
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

    // Discover the user's BMs via the on-chain registry — every id owned by
    // the connected address, in registration order. Fork mode reads the
    // registry's map via derived dynamic fields; the SDK helper simulates a
    // tx and the fork has no simulate_transaction (SUI-FORK-ISSUES #7).
    const bmQuery = useQuery<string[]>({
        queryKey: ["balance-manager-id", account?.address ?? null],
        queryFn: async () => {
            if (!bareClient || !account?.address || !manifest.data) return [];
            if (isForkManifest(manifest.data)) {
                return await forkBalanceManagerIds(
                    coreOf(suiClient),
                    manifest.data.deepbook.registry.objectId,
                    account.address,
                );
            }
            return await bareClient.deepbook.getBalanceManagerIds(account.address);
        },
        enabled: !!bareClient && !!account?.address,
        staleTime: 60_000,
    });

    const balanceManagerIds = useMemo(() => bmQuery.data ?? [], [bmQuery.data]);
    const selected = useSyncExternalStore(
        subscribeSelections,
        selectionsSnapshot,
        selectionsSnapshot,
    );

    // The stored preference only wins while it is still one of the user's
    // managers (a wallet swap or a fork wipe invalidates it).
    const preferred = account?.address ? selected[account.address] : undefined;
    const balanceManagerId =
        (preferred && balanceManagerIds.includes(preferred) ? preferred : balanceManagerIds[0]) ??
        null;

    const selectBalanceManager = useCallback(
        (id: string) => {
            if (account?.address) storeSelection(account.address, id);
        },
        [account?.address],
    );

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
        /** Every manager the registry lists for this wallet, registration order. */
        balanceManagerIds,
        selectBalanceManager,
        isSetup: !!balanceManagerId,
        manifest: manifest.data ?? null,
        manifestLoading: manifest.isLoading,
    };
}

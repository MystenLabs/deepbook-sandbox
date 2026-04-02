/**
 * Lazy-initializing DeepBook SDK client factory.
 *
 * Reads the deployment manifest from /app/deployments/ and creates an
 * extended SuiGrpcClient with the deepbook() registration. The client
 * is cached as a singleton and auto-discovers the deployer's existing
 * BalanceManager on first use.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepbook, type DeepBookClient } from "@mysten/deepbook-v3";
import type { CoinMap, PoolMap, DeepbookPackageIds, BalanceManager } from "@mysten/deepbook-v3";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { ClientWithExtensions } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { SUI_FRAMEWORK_ADDRESS } from "@mysten/sui/utils";

export type SandboxClient = ClientWithExtensions<{ deepbook: DeepBookClient }>;

const MANAGER_KEY = "MANAGER_1";
const DEPLOYMENTS_DIR = "/app/deployments";

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

interface Manifest {
    packages: Record<string, ManifestPackage>;
    pools: Record<string, ManifestPool>;
    deployerAddress: string;
}

/* ------------------------------------------------------------------ */
/*  Manifest loading                                                   */
/* ------------------------------------------------------------------ */

function loadManifest(): Manifest {
    const files = readdirSync(DEPLOYMENTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();
    if (files.length === 0) throw new Error("No deployment manifest found");
    return JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, files[files.length - 1]), "utf-8"));
}

function findObject(objects: ManifestPackage["objects"], match: string, exclude?: string): string {
    const obj = objects.find(
        (o) => o.objectType.includes(match) && (!exclude || !o.objectType.includes(exclude)),
    );
    if (!obj) throw new Error(`Object matching "${match}" not found in manifest`);
    return obj.objectId;
}

/* ------------------------------------------------------------------ */
/*  SDK config builders (same patterns as examples/sandbox/setup.ts)   */
/* ------------------------------------------------------------------ */

function buildPackageIds(manifest: Manifest): DeepbookPackageIds {
    return {
        DEEPBOOK_PACKAGE_ID: manifest.packages.deepbook.packageId,
        REGISTRY_ID: findObject(manifest.packages.deepbook.objects, "Registry", "MarginRegistry"),
        DEEP_TREASURY_ID: findObject(manifest.packages.token.objects, "ProtectedTreasury"),
    };
}

function buildCoinMap(manifest: Manifest): CoinMap {
    return {
        DEEP: {
            address: manifest.packages.token.packageId,
            type: manifest.pools.DEEP_SUI.baseCoinType,
            scalar: 1_000_000,
        },
        SUI: {
            address: SUI_FRAMEWORK_ADDRESS,
            type: `${SUI_FRAMEWORK_ADDRESS}::sui::SUI`,
            scalar: 1_000_000_000,
        },
        USDC: {
            address: manifest.packages.usdc.packageId,
            type: manifest.pools.SUI_USDC.quoteCoinType,
            scalar: 1_000_000,
        },
    };
}

function buildPoolMap(manifest: Manifest): PoolMap {
    return {
        DEEP_SUI: {
            address: manifest.pools.DEEP_SUI.poolId,
            baseCoin: "DEEP",
            quoteCoin: "SUI",
        },
        SUI_USDC: {
            address: manifest.pools.SUI_USDC.poolId,
            baseCoin: "SUI",
            quoteCoin: "USDC",
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Client factory                                                     */
/* ------------------------------------------------------------------ */

let cachedClient: SandboxClient | null = null;
let cachedManifest: Manifest | null = null;
let initPromise: Promise<SandboxClient> | null = null;

function buildClient(
    baseClient: SuiGrpcClient,
    address: string,
    manifest: Manifest,
    balanceManagers?: Record<string, BalanceManager>,
): SandboxClient {
    return baseClient.$extend(
        deepbook({
            address,
            packageIds: buildPackageIds(manifest),
            coins: buildCoinMap(manifest),
            pools: buildPoolMap(manifest),
            balanceManagers,
        }),
    );
}

/**
 * Returns the cached DeepBook SDK client, creating it lazily on first call.
 *
 * Starts with NO BalanceManager registered — the user must create one via
 * the dashboard. This prevents the faucet from accidentally reusing the
 * market maker's BM (same deployer key), which would cause self-matching
 * and object version conflicts.
 */
export async function getOrCreateClient(
    baseClient: SuiGrpcClient,
    signer: Keypair,
): Promise<SandboxClient> {
    if (cachedClient) return cachedClient;

    // Deduplicate concurrent init calls — all callers await the same promise
    if (!initPromise) {
        initPromise = (async () => {
            const manifest = loadManifest();
            cachedManifest = manifest;
            const address = signer.getPublicKey().toSuiAddress();

            // Restore the faucet's own BM if it was created in a previous session.
            // Does NOT auto-discover BMs on-chain — avoids picking up the MM's BM.
            const savedBmId = loadFaucetBmId();
            const balanceManagers = savedBmId
                ? { [MANAGER_KEY]: { address: savedBmId } }
                : undefined;

            cachedClient = buildClient(baseClient, address, manifest, balanceManagers);
            return cachedClient;
        })().finally(() => {
            initPromise = null;
        });
    }

    return initPromise;
}

/**
 * Re-create the SDK client with a newly created BalanceManager registered.
 * Called after createBalanceManager succeeds.
 */
export function recreateClient(
    baseClient: SuiGrpcClient,
    signer: Keypair,
    balanceManagerId: string,
): SandboxClient {
    const manifest = cachedManifest ?? loadManifest();
    cachedManifest = manifest;
    const address = signer.getPublicKey().toSuiAddress();

    cachedClient = buildClient(baseClient, address, manifest, {
        [MANAGER_KEY]: { address: balanceManagerId },
    });
    return cachedClient;
}

/** The key used to register the deployer's BalanceManager in the SDK. */
export const BALANCE_MANAGER_KEY = MANAGER_KEY;

/* ------------------------------------------------------------------ */
/*  Faucet BM persistence (survives container restarts)                */
/* ------------------------------------------------------------------ */

const BM_FILE = "/app/.faucet-bm-id";

/** Save the faucet's own BM ID to disk so it survives restarts. */
export function saveFaucetBmId(bmId: string): void {
    writeFileSync(BM_FILE, bmId, "utf-8");
}

/** Load the faucet's BM ID from disk, or null if not created yet. */
export function loadFaucetBmId(): string | null {
    try {
        const id = readFileSync(BM_FILE, "utf-8").trim();
        return id || null;
    } catch {
        return null;
    }
}

/** Returns the cached manifest's deepbook package ID, if loaded. */
export function getDeepbookPackageId(): string {
    if (!cachedManifest) throw new Error("Client not initialized yet");
    return cachedManifest.packages.deepbook.packageId;
}

/** Returns a map of coin key → full coin type string. */
export function getCoinTypes(): Record<string, string> {
    if (!cachedManifest) throw new Error("Client not initialized yet");
    return {
        SUI: `${SUI_FRAMEWORK_ADDRESS}::sui::SUI`,
        DEEP: cachedManifest.pools.DEEP_SUI.baseCoinType,
        USDC: cachedManifest.pools.SUI_USDC.quoteCoinType,
    };
}

/** Returns the decimal scalar for a coin. */
export function getCoinScalar(coinKey: string): number {
    const scalars: Record<string, number> = {
        SUI: 1_000_000_000,
        DEEP: 1_000_000,
        USDC: 1_000_000,
    };
    return scalars[coinKey] ?? 1_000_000;
}

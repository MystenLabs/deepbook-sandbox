/**
 * Lazy-initializing DeepBook SDK client factory.
 *
 * Reads the deployment manifest from /app/deployments/ and creates an
 * extended SuiGrpcClient with the deepbook() registration. The client
 * is cached as a singleton and auto-discovers the deployer's existing
 * BalanceManager on first use.
 */

import { readFileSync, readdirSync } from "node:fs";
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
 * The BalanceManager ID comes from the BALANCE_MANAGER_ID env var
 * (set by deploy-all during deployment).
 */
export async function getOrCreateClient(
    baseClient: SuiGrpcClient,
    signer: Keypair,
    balanceManagerId?: string,
): Promise<SandboxClient> {
    if (cachedClient) return cachedClient;

    // Deduplicate concurrent init calls — all callers await the same promise
    if (!initPromise) {
        initPromise = (async () => {
            const manifest = loadManifest();
            cachedManifest = manifest;
            const address = signer.getPublicKey().toSuiAddress();

            const balanceManagers = balanceManagerId
                ? { [MANAGER_KEY]: { address: balanceManagerId } }
                : undefined;

            cachedClient = buildClient(baseClient, address, manifest, balanceManagers);
            return cachedClient;
        })().finally(() => {
            initPromise = null;
        });
    }

    return initPromise;
}

/** The key used to register the deployer's BalanceManager in the SDK. */
export const BALANCE_MANAGER_KEY = MANAGER_KEY;

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

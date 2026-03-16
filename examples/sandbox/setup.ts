/**
 * Shared setup for DeepBook sandbox examples.
 *
 * Reads the deployment manifest (written by `pnpm deploy-all`) and constructs
 * a DeepBook SDK client configured for localnet. Provides three entry points
 * with increasing setup complexity:
 *
 *   createReadOnlyClient()       — no keypair, no funding
 *   setupSandbox()               — fresh keypair + faucet funding
 *   setupWithBalanceManager()    — above + on-chain BalanceManager
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deepbook, type DeepBookClient } from "@mysten/deepbook-v3";
import type { CoinMap, DeepbookPackageIds, PoolMap } from "@mysten/deepbook-v3";
import type { BalanceManager } from "@mysten/deepbook-v3";
import type { ClientWithExtensions } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the deployment manifest written by deploy-all.ts */
interface DeploymentManifest {
    network: { type: string; rpcUrl: string; faucetUrl: string };
    packages: Record<
        string,
        {
            packageId: string;
            objects: Array<{ objectId: string; objectType: string }>;
            transactionDigest: string;
        }
    >;
    pools: Record<string, { poolId: string; baseCoinType: string; quoteCoinType: string }>;
    deployerAddress: string;
    deploymentTime: string;
}

export type SandboxClient = ClientWithExtensions<{ deepbook: DeepBookClient }>;

export interface SandboxConfig {
    client: SandboxClient;
    keypair: Ed25519Keypair;
    address: string;
    manifest: DeploymentManifest;
}

export interface SandboxConfigWithBM extends SandboxConfig {
    balanceManagerId: string;
    balanceManagerKey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "../../sandbox/deployments/localnet.json");
const LOCALNET_URL = "http://127.0.0.1:9000";
const FAUCET_URL = "http://127.0.0.1:9009";
const BALANCE_MANAGER_KEY = "MANAGER_1";
const SUI_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000002";

// ---------------------------------------------------------------------------
// Manifest loading & ID extraction
// ---------------------------------------------------------------------------

async function loadManifest(): Promise<DeploymentManifest> {
    try {
        const raw = await readFile(MANIFEST_PATH, "utf-8");
        return JSON.parse(raw) as DeploymentManifest;
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            throw new Error(
                `Deployment manifest not found at ${MANIFEST_PATH}.\n` +
                    `Run "cd sandbox && pnpm deploy-all" first.`,
            );
        }
        throw err;
    }
}

function extractObjectId(
    objects: Array<{ objectId: string; objectType: string }>,
    typeMatch: string,
    exclude?: string,
): string {
    const obj = objects.find(
        (o) => o.objectType.includes(typeMatch) && (!exclude || !o.objectType.includes(exclude)),
    );
    if (!obj) {
        throw new Error(`Could not find object matching "${typeMatch}" in deployment manifest`);
    }
    return obj.objectId;
}

function buildPackageIds(manifest: DeploymentManifest): DeepbookPackageIds {
    const deepbookPkg = manifest.packages.deepbook;
    const tokenPkg = manifest.packages.token;

    return {
        DEEPBOOK_PACKAGE_ID: deepbookPkg.packageId,
        REGISTRY_ID: extractObjectId(deepbookPkg.objects, "Registry", "MarginRegistry"),
        DEEP_TREASURY_ID: extractObjectId(tokenPkg.objects, "ProtectedTreasury"),
    };
}

function buildCoinMap(manifest: DeploymentManifest): CoinMap {
    return {
        DEEP: {
            address: manifest.packages.token.packageId,
            type: manifest.pools.DEEP_SUI.baseCoinType,
            scalar: 1_000_000, // 6 decimals
        },
        SUI: {
            address: SUI_ADDRESS,
            type: `${SUI_ADDRESS}::sui::SUI`,
            scalar: 1_000_000_000, // 9 decimals
        },
        USDC: {
            address: manifest.packages.usdc.packageId,
            type: manifest.pools.SUI_USDC.quoteCoinType,
            scalar: 1_000_000, // 6 decimals
        },
    };
}

function buildPoolMap(manifest: DeploymentManifest): PoolMap {
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

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function createClient(
    address: string,
    manifest: DeploymentManifest,
    balanceManagers?: Record<string, BalanceManager>,
): SandboxClient {
    return new SuiGrpcClient({
        network: "custom",
        baseUrl: LOCALNET_URL,
    }).$extend(
        deepbook({
            address,
            packageIds: buildPackageIds(manifest),
            coins: buildCoinMap(manifest),
            pools: buildPoolMap(manifest),
            balanceManagers,
        }),
    );
}

// ---------------------------------------------------------------------------
// Faucet funding
// ---------------------------------------------------------------------------

async function fundFromFaucet(address: string, token: "SUI" | "DEEP"): Promise<void> {
    const resp = await fetch(`${FAUCET_URL}/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, token }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Faucet request failed for ${token}: ${resp.status} ${body}`);
    }
}

async function fundWallet(address: string): Promise<void> {
    // Fund with both SUI (for gas + quote coin) and DEEP (for base coin / fees)
    await fundFromFaucet(address, "SUI");
    await fundFromFaucet(address, "DEEP");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a read-only client (no keypair, no funding).
 * Suitable for querying order books, mid prices, etc.
 */
export async function createReadOnlyClient(): Promise<{
    client: SandboxClient;
    manifest: DeploymentManifest;
}> {
    const manifest = await loadManifest();
    // Use a zero address for read-only queries
    const zeroAddress = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const client = createClient(zeroAddress, manifest);
    return { client, manifest };
}

/**
 * Full setup: fresh keypair, faucet-funded wallet, configured DeepBook client.
 * Suitable for swaps (no BalanceManager needed).
 */
export async function setupSandbox(): Promise<SandboxConfig> {
    const manifest = await loadManifest();
    const keypair = new Ed25519Keypair();
    const address = keypair.toSuiAddress();

    console.log(`Generated keypair: ${address}`);
    console.log("Funding wallet from sandbox faucet...");
    await fundWallet(address);
    console.log("Wallet funded with SUI and DEEP.\n");

    const client = createClient(address, manifest);
    return { client, keypair, address, manifest };
}

/**
 * Full setup + on-chain BalanceManager creation.
 * Suitable for limit orders, market orders, and order lifecycle examples.
 *
 * Two-step pattern:
 *   1. Create client without BMs → create BM on-chain → extract object ID
 *   2. Re-create client with BM registered under MANAGER_1 key
 */
export async function setupWithBalanceManager(): Promise<SandboxConfigWithBM> {
    const { keypair, address, manifest } = await setupSandbox();

    // Step 1: Create a temporary client (no balance managers)
    const tempClient = createClient(address, manifest);

    // Step 2: Create BalanceManager on-chain
    console.log("Creating BalanceManager on-chain...");
    const tx = new Transaction();
    tempClient.deepbook.balanceManager.createAndShareBalanceManager()(tx);

    const result = await tempClient.core.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        include: { effects: true, objectTypes: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(
            `BalanceManager creation failed: ${JSON.stringify(result.FailedTransaction)}`,
        );
    }

    // Step 3: Extract the created BalanceManager object ID
    const objectTypes = result.Transaction?.objectTypes ?? {};
    const balanceManagerId = result.Transaction?.effects?.changedObjects?.find(
        (obj) =>
            obj.idOperation === "Created" && objectTypes[obj.objectId]?.includes("BalanceManager"),
    )?.objectId;

    if (!balanceManagerId) {
        throw new Error("Failed to extract BalanceManager ID from transaction result");
    }

    console.log(`BalanceManager created: ${balanceManagerId}\n`);

    // Step 4: Re-create client with BM registered
    const client = createClient(address, manifest, {
        [BALANCE_MANAGER_KEY]: { address: balanceManagerId },
    });

    return {
        client,
        keypair,
        address,
        manifest,
        balanceManagerId,
        balanceManagerKey: BALANCE_MANAGER_KEY,
    };
}

/**
 * Sign and execute a transaction, throwing on failure.
 * Returns the successful transaction result.
 */
export async function signAndExecute(
    client: SandboxClient,
    keypair: Ed25519Keypair,
    tx: Transaction,
) {
    const result = await client.core.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        include: { effects: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(`Transaction failed: ${JSON.stringify(result.FailedTransaction)}`);
    }

    return result.Transaction!;
}

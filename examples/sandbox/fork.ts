// examples/sandbox/fork.ts
// Fork-mode implementations of the setup.ts public API (SANDBOX_ENV=fork).
// Ids come from the DBSF-016 pinned manifest (sandbox/deployments/
// mainnet-fork.json); RPC is the fork container's direct host-mapped port (the
// routed *.localhost URL isn't gRPC-reachable from the host); funding keeps the
// sandbox convention — fresh keypair per run, funded over HTTP — via the
// devstack dashboard's `fund` GraphQL mutation (SUI fixed-amount strategy,
// DEEP via the impersonated-whale strategy; both registered by the stack).

import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deepbook, mainnetPackageIds } from "@mysten/deepbook-v3";
import type { BalanceManager, CoinMap, DeepbookPackageIds, PoolMap } from "@mysten/deepbook-v3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SUI_FRAMEWORK_ADDRESS } from "@mysten/sui/utils";

import { createBalanceManager } from "./bm.js";
import type { SandboxClient, SandboxConfig, SandboxConfigWithBM } from "./setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORK_MANIFEST_PATH = join(__dirname, "../../sandbox/deployments/mainnet-fork.json");
const STACK = process.env.SANDBOX_STACK ?? "deepbook-sandbox";
const BALANCE_MANAGER_KEY = "MANAGER_1";
const SUI_TYPE = `${SUI_FRAMEWORK_ADDRESS}::sui::SUI`;

// Base-unit funding amounts (parity with the legacy faucet: SUI for gas/quote,
// DEEP for base/fees). DEEP and USDC have 6 decimals on mainnet.
const DEEP_FUND_BASE_UNITS = "100000000"; // 100 DEEP

interface ForkPoolPin {
    objectId: string;
    baseType: string;
    quoteType: string;
}
interface ForkIds {
    packages: { deepbook: { latestId: string } };
    registry: { objectId: string };
    pools: Record<string, ForkPoolPin>;
}

async function loadForkIds(): Promise<ForkIds> {
    try {
        return JSON.parse(await readFile(FORK_MANIFEST_PATH, "utf-8")).deepbook as ForkIds;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
                `mainnet-fork manifest not found at ${FORK_MANIFEST_PATH} — it is checked in; ` +
                    `are you running from a full checkout?`,
            );
        }
        throw err;
    }
}

/** The fork's gRPC base URL via its direct host-mapped 9000 port. */
export function forkRpcUrl(): string {
    const explicit = process.env.FORK_RPC_URL;
    if (explicit) return explicit;
    const ids = execSync(`docker ps -q --filter name=${STACK}-sui-fork`)
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
    if (ids.length === 0) {
        throw new Error(
            `no running ${STACK}-sui-fork container — run \`pnpm stack:up\` in sandbox/ first ` +
                `(or set FORK_RPC_URL)`,
        );
    }
    const mapped = execSync(`docker port ${ids[0]} 9000/tcp`).toString().trim().split("\n")[0];
    const port = mapped.split(":").pop();
    if (!port || !/^\d+$/.test(port)) {
        throw new Error(`could not resolve fork host port from 'docker port' output: '${mapped}'`);
    }
    return `http://127.0.0.1:${port}`;
}

/** The devstack dashboard listens in the `devstack up` CLI process on a
 *  loopback port. Find it via that process's LISTEN ports and the /graphql
 *  ping probe; SANDBOX_DASHBOARD_URL overrides. */
async function dashboardGraphqlUrl(): Promise<string> {
    const explicit = process.env.SANDBOX_DASHBOARD_URL;
    if (explicit) return explicit.replace(/\/$/, "") + "/graphql";
    // Match both a literal `devstack up` invocation and the resolved CLI
    // entrypoint: `pnpm exec devstack up` resolves the `devstack` bin shim,
    // which `exec`s into `.../@mysten-incubation/devstack/dist/cli/main.mjs`
    // — that `exec` replaces argv, so "devstack" and "up" are no longer
    // adjacent in the running process's command line (verified against a
    // live `pnpm -C devstack-plugins exec devstack up` process).
    const patterns = ["devstack up", "devstack/dist/cli/main.mjs up"];
    const pidSet = new Set<string>();
    for (const pattern of patterns) {
        try {
            const found = execSync(`pgrep -f "${pattern}"`)
                .toString()
                .trim()
                .split("\n")
                .filter(Boolean);
            for (const pid of found) pidSet.add(pid);
        } catch {
            /* no matching process for this pattern */
        }
    }
    const ports = new Set<string>();
    for (const pid of pidSet) {
        try {
            for (const line of execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`)
                .toString()
                .split("\n")) {
                const m = line.match(/:(\d+)\s*\(LISTEN\)/);
                if (m) ports.add(m[1]);
            }
        } catch {
            /* process gone / lsof denied — try the next */
        }
    }
    for (const p of ports) {
        try {
            const r = await fetch(`http://127.0.0.1:${p}/graphql`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: "{ ping }" }),
            });
            if (r.ok && (await r.json())?.data?.ping) return `http://127.0.0.1:${p}/graphql`;
        } catch {
            /* not the dashboard */
        }
    }
    throw new Error(
        "devstack dashboard /graphql not found — is `pnpm stack:up` running? " +
            "Set SANDBOX_DASHBOARD_URL to override.",
    );
}

/** Fund via the dashboard's `fund` mutation. Omit coinType for SUI (fixed
 *  amount — amountBaseUnits ignored); non-SUI coins honor amountBaseUnits. */
export async function fundFromDashboard(
    recipient: string,
    coinType?: string,
    amountBaseUnits?: string,
): Promise<void> {
    const url = await dashboardGraphqlUrl();
    const args = [
        `recipient: "${recipient}"`,
        ...(coinType ? [`coinType: "${coinType}"`] : []),
        ...(amountBaseUnits ? [`amountBaseUnits: "${amountBaseUnits}"`] : []),
    ].join(", ");
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `mutation { fund(input: { ${args} }) { ok detail } }` }),
    });
    if (!res.ok) throw new Error(`dashboard fund request failed: HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.data?.fund;
    if (!result?.ok) {
        throw new Error(
            `dashboard fund failed for ${coinType ?? "SUI"}: ${result?.detail ?? JSON.stringify(json?.errors ?? json)}`,
        );
    }
}

function typeAddress(fullType: string): string {
    return fullType.split("::")[0];
}

function buildPackageIds(ids: ForkIds): DeepbookPackageIds {
    return {
        DEEPBOOK_PACKAGE_ID: ids.packages.deepbook.latestId,
        REGISTRY_ID: ids.registry.objectId,
        DEEP_TREASURY_ID: mainnetPackageIds.DEEP_TREASURY_ID,
    };
}

function buildCoinMap(ids: ForkIds): CoinMap {
    const deepType = ids.pools.DEEP_SUI.baseType;
    const usdcType = ids.pools.SUI_USDC.quoteType;
    return {
        DEEP: { address: typeAddress(deepType), type: deepType, scalar: 1_000_000 },
        SUI: { address: SUI_FRAMEWORK_ADDRESS, type: SUI_TYPE, scalar: 1_000_000_000 },
        USDC: { address: typeAddress(usdcType), type: usdcType, scalar: 1_000_000 },
    };
}

function buildPoolMap(ids: ForkIds): PoolMap {
    return {
        DEEP_SUI: { address: ids.pools.DEEP_SUI.objectId, baseCoin: "DEEP", quoteCoin: "SUI" },
        SUI_USDC: { address: ids.pools.SUI_USDC.objectId, baseCoin: "SUI", quoteCoin: "USDC" },
        DEEP_USDC: { address: ids.pools.DEEP_USDC.objectId, baseCoin: "DEEP", quoteCoin: "USDC" },
    };
}

/** Minimal DeploymentManifest-shaped adapter so SandboxConfig.manifest keeps
 *  its type; no example script reads beyond `pools`/`network`. */
function manifestAdapter(ids: ForkIds, rpcUrl: string): SandboxConfig["manifest"] {
    return {
        network: { type: "mainnet-fork", rpcUrl, faucetUrl: "" },
        packages: {},
        pools: Object.fromEntries(
            Object.entries(ids.pools).map(([key, p]) => [
                key,
                { poolId: p.objectId, baseCoinType: p.baseType, quoteCoinType: p.quoteType },
            ]),
        ),
        deployerAddress: "",
        deploymentTime: "",
    };
}

function createForkClient(
    address: string,
    ids: ForkIds,
    rpcUrl: string,
    balanceManagers?: Record<string, BalanceManager>,
): SandboxClient {
    return new SuiGrpcClient({ network: "custom", baseUrl: rpcUrl }).$extend(
        deepbook({
            address,
            packageIds: buildPackageIds(ids),
            coins: buildCoinMap(ids),
            pools: buildPoolMap(ids),
            balanceManagers,
        }),
    );
}

export async function createReadOnlyClientFork(): Promise<{
    client: SandboxClient;
    manifest: SandboxConfig["manifest"];
}> {
    const ids = await loadForkIds();
    const rpcUrl = forkRpcUrl();
    const zeroAddress = "0x0000000000000000000000000000000000000000000000000000000000000000";
    return {
        client: createForkClient(zeroAddress, ids, rpcUrl),
        manifest: manifestAdapter(ids, rpcUrl),
    };
}

export async function setupSandboxFork(): Promise<SandboxConfig> {
    const ids = await loadForkIds();
    const rpcUrl = forkRpcUrl();
    const keypair = new Ed25519Keypair();
    const address = keypair.toSuiAddress();

    console.log(`Generated keypair: ${address}`);
    console.log("Funding wallet via the devstack dashboard faucet...");
    await fundFromDashboard(address); // SUI (fixed amount)
    await fundFromDashboard(address, buildCoinMap(ids).DEEP.type, DEEP_FUND_BASE_UNITS);
    console.log("Wallet funded with SUI and DEEP.\n");

    return {
        client: createForkClient(address, ids, rpcUrl),
        keypair,
        address,
        manifest: manifestAdapter(ids, rpcUrl),
    };
}

export async function setupWithBalanceManagerFork(): Promise<SandboxConfigWithBM> {
    const base = await setupSandboxFork();
    const ids = await loadForkIds();
    const rpcUrl = forkRpcUrl();

    console.log("Creating BalanceManager on-chain...");
    const balanceManagerId = await createBalanceManager(base.client, base.keypair);
    console.log(`BalanceManager created: ${balanceManagerId}\n`);

    return {
        ...base,
        client: createForkClient(base.address, ids, rpcUrl, {
            [BALANCE_MANAGER_KEY]: { address: balanceManagerId },
        }),
        balanceManagerId,
        balanceManagerKey: BALANCE_MANAGER_KEY,
    };
}

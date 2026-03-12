/**
 * Integration tests for the deploy-all pipeline.
 *
 * Runs against a real Sui localnet via Docker. Tests are sequential —
 * each phase depends on the previous one. Deployment runs once (~5 min)
 * and all assertions share state via describe-level variables.
 *
 * A fresh Ed25519 keypair is generated inside the sui-localnet container
 * via `sui keytool generate`, then extracted and imported into the host's
 * `sui` CLI keystore. No manual PRIVATE_KEY is needed.
 *
 * Prerequisites:
 *   - Docker running
 *   - `sui` CLI on PATH
 *   - Git submodule initialized (external/deepbook/)
 *
 * Usage:
 *   cd sandbox
 *   pnpm test:integration
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Keypair } from "@mysten/sui/cryptography";

import {
    startLocalnet,
    configureAndStartLocalnetServices,
    startOracleService,
    startMarketMaker,
} from "../utils/docker-compose";
import { MoveDeployer, type DeploymentResult } from "../utils/deployer";
import { ensureMinimumBalance, getDeploymentEnv } from "../utils/helpers";
import { updateEnvFile } from "../utils/env";
import { readContainerKey, importKeyToHostCli, defaultSuiToolsImage } from "../utils/keygen";
import { setupPythOracles, type PythOracleIds } from "../utils/oracle";
import { PoolCreator, type PoolEntry, type MarginPoolsResult } from "../utils/pool";
import { expectValidSuiId, waitForUrl, expectContainerRunning } from "./helpers/assertions";

// ---------------------------------------------------------------------------
// Resolve paths — avoid importing config.ts (has dotenv/config side effect)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = path.resolve(__dirname, "../..");
const ENV_FILE = ".env.test";
const ENV_PATH = path.join(SANDBOX_ROOT, ENV_FILE);
const DEPLOYMENTS_DIR = path.join(SANDBOX_ROOT, "deployments");

const RPC_URL = "http://127.0.0.1:9000";
const FAUCET_HOST = "http://127.0.0.1:9123";

// ---------------------------------------------------------------------------
// Docker cleanup helper
// ---------------------------------------------------------------------------

function cleanupLocalnet(cwd: string): void {
    const envFileArgs = process.env.SANDBOX_ENV_FILE
        ? ["--env-file", process.env.SANDBOX_ENV_FILE]
        : [];
    spawnSync(
        "docker",
        ["compose", ...envFileArgs, "--profile", "localnet", "down", "-v", "--remove-orphans"],
        { cwd, encoding: "utf-8", stdio: "inherit" },
    );

    // Remove publish manifests left behind by container-side `sui client test-publish`.
    // If not cleaned up they can break subsequent test runs.
    const fsSync = require("fs");
    for (const name of ["pub.localnet.toml", "Pub.localnet.toml"]) {
        try {
            fsSync.unlinkSync(path.join(cwd, name));
        } catch {
            /* may not exist */
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy-all pipeline (localnet)", () => {
    // Shared mutable state — populated by successive tests
    let client: SuiClient;
    let signer: Keypair;
    let signerAddress: string;
    let deployedPackages: Map<string, DeploymentResult>;
    let pythOracleIds: PythOracleIds;
    let pools: Record<string, PoolEntry>;
    let marginResult: MarginPoolsResult;

    // Exit handler ref so we can deregister in afterAll
    let exitHandler: (() => void) | undefined;

    beforeAll(async () => {
        client = new SuiClient({ url: RPC_URL });

        // ── Route all env file I/O to .env.test (keeps user's .env untouched) ──
        process.env.SANDBOX_ENV_FILE = ENV_FILE;

        // ── Write minimal .env.test for Docker Compose ───────────────
        // PRIVATE_KEY is a placeholder — docker-compose validates all
        // ${VAR:?...} refs even for services we don't start yet.
        // The real key is generated inside the container in the first test.
        const placeholderKey = Ed25519Keypair.generate().getSecretKey();
        const envContent =
            [
                `PRIVATE_KEY=${placeholderKey}`,
                `NETWORK=localnet`,
                `SUI_TOOLS_IMAGE=${process.env.SUI_TOOLS_IMAGE ?? defaultSuiToolsImage()}`,
                `FORCE_REGENESIS=true`,
            ].join("\n") + "\n";
        await fs.writeFile(ENV_PATH, envContent, "utf-8");

        // ── Clean slate: tear down any leftover containers ───────────
        cleanupLocalnet(SANDBOX_ROOT);

        // ── Register exit handler to clean up on crash/Ctrl+C ────────
        exitHandler = () => cleanupLocalnet(SANDBOX_ROOT);
        process.on("exit", exitHandler);
    }, 300_000);

    // ----------------------------------------------------------------
    // Phase 1: Start localnet + read the key generated by the container
    // ----------------------------------------------------------------
    test("starts localnet", async () => {
        const { rpcPort, faucetPort } = await startLocalnet(SANDBOX_ROOT);
        expect(rpcPort).toBe(9000);
        expect(faucetPort).toBe(9123);

        // RPC should be responding
        await waitForUrl(RPC_URL, { timeoutMs: 30_000, label: "RPC" });

        // Faucet should be responding
        await waitForUrl(FAUCET_HOST, { timeoutMs: 30_000, label: "Faucet" });

        // Containers should be running
        expectContainerRunning("sui-localnet");
        expectContainerRunning("deepbook-postgres");

        // Read the keypair that sui-localnet generated at startup
        const { keypair, privateKey } = readContainerKey(SANDBOX_ROOT);
        signer = keypair;
        signerAddress = keypair.getPublicKey().toSuiAddress();

        // Replace the placeholder in .env with the real key
        updateEnvFile(SANDBOX_ROOT, { PRIVATE_KEY: privateKey });

        // Import into the host's sui CLI (best-effort, not required for localnet
        // since publishing runs inside the container via docker exec)
        try {
            importKeyToHostCli(privateKey, signerAddress);
        } catch {
            // host sui binary not available — fine, container handles publishing
        }
    }, 600_000);

    // ----------------------------------------------------------------
    // Phase 2: Fund deployer
    // ----------------------------------------------------------------
    test("funds deployer", async () => {
        await ensureMinimumBalance(client, signerAddress, FAUCET_HOST);

        const { totalBalance } = await client.getBalance({ owner: signerAddress });
        expect(BigInt(totalBalance)).toBeGreaterThanOrEqual(BigInt(1_000_000_000));
    }, 60_000);

    // ----------------------------------------------------------------
    // Phase 3: Deploy Move packages
    // ----------------------------------------------------------------
    test("deploys Move packages", async () => {
        const deployer = new MoveDeployer(client, signer, "localnet");
        deployedPackages = await deployer.deployAll();

        // Should deploy all 6 packages
        expect(deployedPackages.size).toBe(6);
        expect([...deployedPackages.keys()].sort()).toEqual([
            "deepbook",
            "deepbook_margin",
            "margin_liquidation",
            "pyth",
            "token",
            "usdc",
        ]);

        // All packageIds should be valid Sui IDs
        for (const [, result] of deployedPackages) {
            expectValidSuiId(result.packageId);
        }

        // Token should have ProtectedTreasury
        const token = deployedPackages.get("token")!;
        const treasury = token.createdObjects.find((o) =>
            o.objectType.includes("ProtectedTreasury"),
        );
        expect(treasury).toBeDefined();

        // DeepBook should have Registry and AdminCap
        const deepbook = deployedPackages.get("deepbook")!;
        const registry = deepbook.createdObjects.find((o) => o.objectType.includes("Registry"));
        const adminCap = deepbook.createdObjects.find((o) =>
            o.objectType.includes("DeepbookAdminCap"),
        );
        expect(registry).toBeDefined();
        expect(adminCap).toBeDefined();
    }, 480_000);

    // ----------------------------------------------------------------
    // Phase 4: Write package IDs to .env
    // ----------------------------------------------------------------
    test("writes package IDs to .env", async () => {
        const envUpdates = getDeploymentEnv(deployedPackages, {});
        envUpdates.FIRST_CHECKPOINT = "0";
        updateEnvFile(SANDBOX_ROOT, envUpdates);

        const envContent = await fs.readFile(ENV_PATH, "utf-8");
        expect(envContent).toContain("DEEPBOOK_PACKAGE_ID=");
        expect(envContent).toContain("DEEP_TOKEN_PACKAGE_ID=");
        expect(envContent).toContain("DEEP_TREASURY_ID=");
        expect(envContent).toContain("DEEPBOOK_MARGIN_PACKAGE_ID=");
        expect(envContent).toContain("FIRST_CHECKPOINT=0");
    }, 10_000);

    // ----------------------------------------------------------------
    // Phase 5: Start localnet services (indexer, server, faucet, MM)
    // ----------------------------------------------------------------
    test("starts localnet services", async () => {
        const deepbookPkg = deployedPackages.get("deepbook")!;
        const marginPkg = deployedPackages.get("deepbook_margin");
        await configureAndStartLocalnetServices(
            {
                corePackageId: deepbookPkg.packageId,
                ...(marginPkg && { marginPackageId: marginPkg.packageId }),
            },
            SANDBOX_ROOT,
            { quick: true },
        );

        // Indexer metrics should respond
        await waitForUrl("http://127.0.0.1:9184/metrics", {
            timeoutMs: 180_000,
            label: "Indexer metrics",
        });

        // DeepBook server should respond
        await waitForUrl("http://127.0.0.1:9008/", {
            timeoutMs: 120_000,
            label: "DeepBook server",
        });

        // Faucet service should respond
        await waitForUrl("http://127.0.0.1:9009/", {
            timeoutMs: 60_000,
            label: "DeepBook faucet",
        });
    }, 600_000);

    // ----------------------------------------------------------------
    // Phase 6: Setup Pyth oracles
    // ----------------------------------------------------------------
    test("creates Pyth oracles", async () => {
        pythOracleIds = await setupPythOracles(client, signer, deployedPackages);

        expectValidSuiId(pythOracleIds.deepPriceInfoObjectId);
        expectValidSuiId(pythOracleIds.suiPriceInfoObjectId);
        expectValidSuiId(pythOracleIds.usdcPriceInfoObjectId);

        // All three IDs should be distinct
        const ids = [
            pythOracleIds.deepPriceInfoObjectId,
            pythOracleIds.suiPriceInfoObjectId,
            pythOracleIds.usdcPriceInfoObjectId,
        ];
        expect(new Set(ids).size).toBe(3);

        // Objects should exist on-chain
        for (const id of ids) {
            const obj = await client.getObject({ id });
            expect(obj.data, `PriceInfoObject ${id} not found`).toBeDefined();
        }
    }, 60_000);

    // ----------------------------------------------------------------
    // Phase 7: Create deepbook pools and margin pools
    // (Must run before the oracle service starts, because the oracle
    //  transacts with the same signer every 10 s — racing for gas coins
    //  causes equivocation errors.)
    // ----------------------------------------------------------------
    test("creates DEEP/SUI and SUI/USDC pools", async () => {
        const poolCreator = new PoolCreator(client, signer, FAUCET_HOST);
        const result = await poolCreator.createDeepbookPools(deployedPackages);
        pools = result.pools;

        // DEEP/SUI pool
        expect(pools.DEEP_SUI).toBeDefined();
        expectValidSuiId(pools.DEEP_SUI.poolId);
        expect(pools.DEEP_SUI.baseCoinType).toContain("::deep::DEEP");

        const deepSuiObj = await client.getObject({
            id: pools.DEEP_SUI.poolId,
            options: { showType: true },
        });
        expect(deepSuiObj.data).toBeDefined();
        expect(deepSuiObj.data!.type).toContain("::pool::Pool<");

        // SUI/USDC pool
        expect(pools.SUI_USDC).toBeDefined();
        expectValidSuiId(pools.SUI_USDC.poolId);
        expect(pools.SUI_USDC.quoteCoinType).toContain("::usdc::USDC");

        const suiUsdcObj = await client.getObject({
            id: pools.SUI_USDC.poolId,
            options: { showType: true },
        });
        expect(suiUsdcObj.data).toBeDefined();
        expect(suiUsdcObj.data!.type).toContain("::pool::Pool<");
    }, 120_000);

    // ----------------------------------------------------------------
    // Phase 7b: Create margin pools (SUI + USDC)
    // ----------------------------------------------------------------
    test("creates margin pools", async () => {
        const poolCreator = new PoolCreator(client, signer, FAUCET_HOST);
        marginResult = await poolCreator.createMarginPools(deployedPackages, pools);

        expect(marginResult.marginPools.SUI).toBeTruthy();
        expect(marginResult.marginPools.USDC).toBeTruthy();
        expectValidSuiId(marginResult.registryId);
    }, 120_000);

    // ----------------------------------------------------------------
    // Phase 8: Write oracle env + start oracle service
    // ----------------------------------------------------------------
    test("starts oracle service", async () => {
        const pythPkg = deployedPackages.get("pyth")!;

        // Generate a dedicated oracle keypair and fund it
        const oracleKeypair = Ed25519Keypair.generate();
        const oracleAddress = oracleKeypair.getPublicKey().toSuiAddress();
        await ensureMinimumBalance(client, oracleAddress, FAUCET_HOST);

        updateEnvFile(SANDBOX_ROOT, {
            PYTH_PACKAGE_ID: pythPkg.packageId,
            DEEP_PRICE_INFO_OBJECT_ID: pythOracleIds.deepPriceInfoObjectId,
            SUI_PRICE_INFO_OBJECT_ID: pythOracleIds.suiPriceInfoObjectId,
            USDC_PRICE_INFO_OBJECT_ID: pythOracleIds.usdcPriceInfoObjectId,
            ORACLE_PRIVATE_KEY: oracleKeypair.getSecretKey(),
        });

        const envContent = await fs.readFile(ENV_PATH, "utf-8");
        expect(envContent).toContain("PYTH_PACKAGE_ID=");
        expect(envContent).toContain("DEEP_PRICE_INFO_OBJECT_ID=");
        expect(envContent).toContain("SUI_PRICE_INFO_OBJECT_ID=");
        expect(envContent).toContain("USDC_PRICE_INFO_OBJECT_ID=");
        expect(envContent).toContain("ORACLE_PRIVATE_KEY=");

        await startOracleService(SANDBOX_ROOT);

        // Oracle status endpoint should respond
        await waitForUrl("http://127.0.0.1:9010/", {
            timeoutMs: 120_000,
            label: "Oracle service",
        });
    }, 120_000);

    // ----------------------------------------------------------------
    // Phase 9: Start market maker
    // ----------------------------------------------------------------
    test("starts market maker", async () => {
        updateEnvFile(SANDBOX_ROOT, {
            DEEPBOOK_PACKAGE_ID: deployedPackages.get("deepbook")!.packageId,
            POOL_ID: pools.DEEP_SUI.poolId,
            BASE_COIN_TYPE: pools.DEEP_SUI.baseCoinType,
            DEPLOYER_ADDRESS: signerAddress,
        });

        await startMarketMaker(SANDBOX_ROOT);

        // Health endpoint should eventually respond
        await waitForUrl("http://127.0.0.1:3001/health", {
            timeoutMs: 60_000,
            label: "Market maker",
        });
    }, 120_000);

    // ----------------------------------------------------------------
    // E2E: Faucet distributes SUI
    // ----------------------------------------------------------------
    test("faucet distributes SUI", async () => {
        // Generate a fresh keypair to receive funds
        const freshKeypair = Ed25519Keypair.generate();
        const freshAddress = freshKeypair.getPublicKey().toSuiAddress();

        const res = await fetch("http://127.0.0.1:9009/faucet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: freshAddress, token: "SUI" }),
            signal: AbortSignal.timeout(30_000),
        });
        expect(res.status).toBe(200);

        // Wait for tx to settle
        await new Promise((r) => setTimeout(r, 3_000));

        const { totalBalance } = await client.getBalance({ owner: freshAddress });
        expect(BigInt(totalBalance)).toBeGreaterThan(0n);
    }, 30_000);

    // ----------------------------------------------------------------
    // E2E: Oracle reports prices
    // ----------------------------------------------------------------
    test("oracle reports prices", async () => {
        // Give the oracle time to perform at least one update cycle
        await new Promise((r) => setTimeout(r, 15_000));

        const res = await fetch("http://127.0.0.1:9010/", { signal: AbortSignal.timeout(30_000) });
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toBeDefined();
        // The oracle status endpoint returns JSON with status and update info
        expect(body.status).toBeDefined();
    }, 60_000);

    // ----------------------------------------------------------------
    // Completeness guard: every localnet-profile service must be running.
    // If a new service is added to the localnet profile in
    // docker-compose.yml, this test fails until it is started and
    // health-checked by a test above.
    // ----------------------------------------------------------------
    test("all localnet services are running", () => {
        const envFileArgs = process.env.SANDBOX_ENV_FILE
            ? ["--env-file", process.env.SANDBOX_ENV_FILE]
            : [];
        const configResult = spawnSync(
            "docker",
            ["compose", ...envFileArgs, "--profile", "localnet", "config", "--services"],
            { cwd: SANDBOX_ROOT, encoding: "utf-8" },
        );
        const services = configResult.stdout.trim().split("\n").filter(Boolean).sort();
        expect(services.length, "docker compose returned no services").toBeGreaterThan(0);

        for (const service of services) {
            const ps = spawnSync(
                "docker",
                [
                    "compose",
                    ...envFileArgs,
                    "--profile",
                    "localnet",
                    "ps",
                    "--format",
                    "{{.State}}",
                    service,
                ],
                { cwd: SANDBOX_ROOT, encoding: "utf-8" },
            );
            const state = ps.stdout.trim();
            expect(
                state,
                `Service '${service}' is not running (state: '${state}'). ` +
                    `If this is a new service, add a health check test above.`,
            ).toBe("running");
        }
    }, 30_000);

    // ----------------------------------------------------------------
    // Cleanup
    // ----------------------------------------------------------------
    afterAll(async () => {
        // Tear down containers
        cleanupLocalnet(SANDBOX_ROOT);

        // Remove .env.test and reset routing
        try {
            await fs.unlink(ENV_PATH);
        } catch {
            /* may not exist */
        }
        delete process.env.SANDBOX_ENV_FILE;

        // Remove shared keystore
        try {
            await fs.unlink(path.join(DEPLOYMENTS_DIR, ".sui-keystore"));
        } catch {
            // may not exist
        }

        // Deregister exit handler
        if (exitHandler) {
            process.removeListener("exit", exitHandler);
            exitHandler = undefined;
        }
    }, 120_000);
});

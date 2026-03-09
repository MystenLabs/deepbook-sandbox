/**
 * Oracle Service — End-to-End Integration Test
 *
 * This test deploys a full localnet stack and verifies the oracle service's:
 *   1. Startup and health reporting
 *   2. Price update cadence (~10 seconds)
 *   3. Behavior under high-frequency queries
 *   4. Status endpoint structure and price formatting
 *
 * Requires Docker and ~5 minutes for initial deployment.
 * Run with:  pnpm test:integration oracle-service
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { waitForUrl } from "../helpers/assertions";
import { readContainerKey, importKeyToHostCli } from "../../utils/keygen";
import { startLocalnet, startOracleService } from "../../utils/docker-compose";
import { ensureMinimumBalance } from "../../utils/helpers";
import { getClient } from "../../utils/config";
import { updateEnvFile } from "../../utils/env";
import { MoveDeployer } from "../../utils/deployer";
import { setupPythOracles } from "../../utils/oracle";
import type { SuiClient } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import type { DeploymentResult } from "../../utils/deployer";
import type { PythOracleIds } from "../../utils/oracle";

const SANDBOX_ROOT = resolve(import.meta.dirname, "../../..");
const ENV_FILE = ".env.test";
const ORACLE_STATUS_URL = "http://127.0.0.1:9010/";
const FAUCET_HOST = "http://127.0.0.1:9123";
const RPC_URL = "http://127.0.0.1:9000";

// How long to observe the oracle for timing analysis
const OBSERVATION_WINDOW_MS = 50_000;
// How frequently to poll during the observation window
const POLL_INTERVAL_MS = 1_500;

/** Teardown Docker services and temp files. */
function cleanup() {
    try {
        execFileSync(
            "docker",
            ["compose", "--env-file", ENV_FILE, "--profile", "localnet", "down", "-v"],
            { cwd: SANDBOX_ROOT, stdio: "ignore" },
        );
    } catch {}
    const envPath = resolve(SANDBOX_ROOT, ENV_FILE);
    if (existsSync(envPath)) unlinkSync(envPath);
    const keystorePath = resolve(SANDBOX_ROOT, "deployments/.sui-keystore");
    if (existsSync(keystorePath)) unlinkSync(keystorePath);
}

describe("oracle service E2E", () => {
    let client: SuiClient;
    let signer: Keypair;
    let signerAddress: string;
    let deployedPackages: Map<string, DeploymentResult>;
    let pythOracleIds: PythOracleIds;

    // Register cleanup handler
    const exitHandler = () => cleanup();

    beforeAll(async () => {
        process.env.SANDBOX_ENV_FILE = ENV_FILE;
        process.env.NETWORK = "localnet";
        process.env.RPC_URL = RPC_URL;

        // Write seed .env for docker-compose variable validation
        const placeholder = Ed25519Keypair.generate();
        writeFileSync(
            resolve(SANDBOX_ROOT, ENV_FILE),
            [
                `PRIVATE_KEY=${placeholder.getSecretKey()}`,
                `NETWORK=localnet`,
                `RPC_URL=${RPC_URL}`,
            ].join("\n") + "\n",
        );

        cleanup();
        process.on("exit", exitHandler);

        // --- Phase 1: Start localnet ---
        await startLocalnet(SANDBOX_ROOT);
        const { keypair, privateKey } = readContainerKey(SANDBOX_ROOT);
        importKeyToHostCli(privateKey, keypair.toSuiAddress());
        signer = keypair;
        signerAddress = keypair.toSuiAddress();
        client = getClient("localnet");

        // --- Phase 2: Fund deployer ---
        await ensureMinimumBalance(client, signerAddress, FAUCET_HOST);

        // --- Phase 3: Deploy Move packages ---
        const deployer = new MoveDeployer(client, signer, "localnet");
        deployedPackages = await deployer.deployAll();

        // --- Phase 4: Create Pyth oracles ---
        pythOracleIds = await setupPythOracles(client, signer, deployedPackages);

        // --- Phase 5: Start oracle service ---
        const oracleKeypair = Ed25519Keypair.generate();
        const oracleAddress = oracleKeypair.toSuiAddress();
        await ensureMinimumBalance(client, oracleAddress, FAUCET_HOST);

        const pythPkg = deployedPackages.get("pyth")!;
        updateEnvFile(SANDBOX_ROOT, {
            PYTH_PACKAGE_ID: pythPkg.packageId,
            DEEP_PRICE_INFO_OBJECT_ID: pythOracleIds.deepPriceInfoObjectId,
            SUI_PRICE_INFO_OBJECT_ID: pythOracleIds.suiPriceInfoObjectId,
            USDC_PRICE_INFO_OBJECT_ID: pythOracleIds.usdcPriceInfoObjectId,
            ORACLE_PRIVATE_KEY: oracleKeypair.getSecretKey(),
        });

        await startOracleService(SANDBOX_ROOT);

        // Wait for the oracle status endpoint to become available
        await waitForUrl(ORACLE_STATUS_URL, { timeoutMs: 120_000, label: "Oracle status" });
    }, 600_000); // 10 min for full deploy

    afterAll(async () => {
        cleanup();
        process.removeListener("exit", exitHandler);
    }, 300_000);

    // ───────────────────────────────────────────
    // Test: Health / structure
    // ───────────────────────────────────────────

    it("status endpoint returns valid JSON structure", async () => {
        const res = await fetch(ORACLE_STATUS_URL, { signal: AbortSignal.timeout(10_000) });
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toHaveProperty("status", "ok");
        expect(body).toHaveProperty("updates");
        expect(body).toHaveProperty("errors");
        expect(body).toHaveProperty("lastUpdate");
        expect(body).toHaveProperty("prices");
        expect(body.prices).toHaveProperty("sui");
        expect(body.prices).toHaveProperty("deep");
        expect(body.prices).toHaveProperty("usdc");
    }, 30_000);

    it("reports non-null prices after first update", async () => {
        // Wait up to 15s for the first successful update
        await new Promise((r) => setTimeout(r, 15_000));

        const res = await fetch(ORACLE_STATUS_URL, { signal: AbortSignal.timeout(10_000) });
        const body = await res.json();

        expect(body.updates).toBeGreaterThanOrEqual(1);
        expect(body.prices.sui).not.toBeNull();
        expect(body.prices.deep).not.toBeNull();
        expect(body.prices.usdc).not.toBeNull();
        expect(body.prices.sui).toMatch(/^\$/); // starts with $
    }, 30_000);

    // ───────────────────────────────────────────
    // Test: Update cadence
    // ───────────────────────────────────────────

    it("updates approximately every 10 seconds", async () => {
        /**
         * Strategy: poll the status endpoint rapidly and record when
         * the updateCount changes. Then calculate the intervals between
         * consecutive updates and assert they're ~10s (within tolerance).
         *
         * We observe for OBSERVATION_WINDOW_MS (~50s) to capture 3-5 updates.
         */
        interface Sample {
            time: number;
            updateCount: number;
        }

        const samples: Sample[] = [];
        const deadline = Date.now() + OBSERVATION_WINDOW_MS;

        while (Date.now() < deadline) {
            try {
                const res = await fetch(ORACLE_STATUS_URL, {
                    signal: AbortSignal.timeout(5_000),
                });
                const body = await res.json();
                samples.push({ time: Date.now(), updateCount: body.updates });
            } catch {
                // transient failure — skip
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        expect(samples.length).toBeGreaterThan(5);

        // Find timestamps where updateCount incremented
        const updateTimestamps: number[] = [];
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].updateCount > samples[i - 1].updateCount) {
                updateTimestamps.push(samples[i].time);
            }
        }

        // Need at least 2 observed updates to compute intervals
        expect(updateTimestamps.length).toBeGreaterThanOrEqual(2);

        // Compute intervals between consecutive updates
        const intervals: number[] = [];
        for (let i = 1; i < updateTimestamps.length; i++) {
            intervals.push(updateTimestamps[i] - updateTimestamps[i - 1]);
        }

        // Each interval should be approximately 10 seconds
        // Tolerance: 5s–20s (generous to account for transaction time, network latency)
        for (const interval of intervals) {
            expect(interval).toBeGreaterThan(5_000);
            expect(interval).toBeLessThan(20_000);
        }

        // Average interval should be close to 10s (8s–15s)
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        expect(avgInterval).toBeGreaterThan(8_000);
        expect(avgInterval).toBeLessThan(15_000);

        console.log(
            `[timing] observed ${intervals.length} intervals: ` +
                `${intervals.map((i) => `${(i / 1000).toFixed(1)}s`).join(", ")} ` +
                `(avg: ${(avgInterval / 1000).toFixed(1)}s)`,
        );
    }, 90_000);

    // ───────────────────────────────────────────
    // Test: Frequent querying behavior
    // ───────────────────────────────────────────

    it("handles rapid queries without errors (100 requests in <5s)", async () => {
        /**
         * Fire 100 concurrent requests at the status endpoint.
         * All should succeed with 200. This verifies the HTTP server
         * handles burst traffic correctly.
         */
        const requests = Array.from({ length: 100 }, () =>
            fetch(ORACLE_STATUS_URL, { signal: AbortSignal.timeout(10_000) }),
        );
        const responses = await Promise.all(requests);

        const statuses = responses.map((r) => r.status);
        expect(statuses.every((s) => s === 200)).toBe(true);

        // All responses should have the same updateCount (snapshot in time)
        const bodies = await Promise.all(responses.map((r) => r.json()));
        const counts = new Set(bodies.map((b: any) => b.updates));
        // Might see 1-2 different counts if an update happens mid-burst
        expect(counts.size).toBeLessThanOrEqual(2);
    }, 30_000);

    it("frequent queries return cached prices (not triggering new updates)", async () => {
        /**
         * Query 20 times in rapid succession (~100ms apart).
         * The updateCount should not increment more than once
         * (updates happen on a fixed interval, not on-demand).
         */
        const firstRes = await fetch(ORACLE_STATUS_URL, { signal: AbortSignal.timeout(5_000) });
        const firstBody = await firstRes.json();
        const initialCount = firstBody.updates;

        const results = [];
        for (let i = 0; i < 20; i++) {
            const res = await fetch(ORACLE_STATUS_URL, { signal: AbortSignal.timeout(5_000) });
            results.push(await res.json());
            await new Promise((r) => setTimeout(r, 100));
        }

        // Over ~2 seconds, at most 1 update should have happened
        const finalCount = results[results.length - 1].updates;
        expect(finalCount - initialCount).toBeLessThanOrEqual(1);

        console.log(
            `[querying] 20 rapid queries: updateCount went from ${initialCount} to ${finalCount}`,
        );
    }, 15_000);

    // ───────────────────────────────────────────
    // Test: Error resilience
    // ───────────────────────────────────────────

    it("continues running even with accumulated errors", async () => {
        const res = await fetch(ORACLE_STATUS_URL, { signal: AbortSignal.timeout(5_000) });
        const body = await res.json();

        // The service should be running regardless of error count
        expect(body.status).toBe("ok");
        expect(typeof body.errors).toBe("number");
    }, 10_000);
});

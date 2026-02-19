/**
 * End-to-end test for deploy-all.ts run as a subprocess.
 *
 * Unlike deploy-pipeline.integration.test.ts (which calls individual utility
 * functions), this test spawns `tsx scripts/deploy-all.ts` exactly as
 * `pnpm deploy-all` does. This verifies the actual developer experience:
 *   - process.exit(1) on failure won't kill vitest
 *   - dotenv/config side-effect stays in the subprocess
 *   - stdout/stderr are streamed for debugging
 *
 * Prerequisites:
 *   - Docker running
 *   - `sui` CLI on PATH
 *   - Git submodule initialized (external/deepbook/)
 *
 * Usage:
 *   cd sandbox
 *   pnpm test:integration deploy-all-e2e
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { defaultSuiToolsImage } from "../utils/keygen";
import { expectValidSuiId, waitForUrl } from "./helpers/assertions";

// ---------------------------------------------------------------------------
// Resolve paths — avoid importing config.ts (has dotenv/config side effect)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(SANDBOX_ROOT, ".env");
const DEPLOYMENTS_DIR = path.join(SANDBOX_ROOT, "deployments");

const RPC_URL = "http://127.0.0.1:9000";

// ---------------------------------------------------------------------------
// Docker cleanup helper
// ---------------------------------------------------------------------------

function dockerDown(cwd: string): void {
    spawnSync("docker", ["compose", "--profile", "localnet", "down", "-v", "--remove-orphans"], {
        cwd,
        encoding: "utf-8",
        stdio: "inherit",
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the most recent *_localnet.json manifest in deployments/ */
async function findManifest(): Promise<string | undefined> {
    let entries: string[];
    try {
        entries = await fs.readdir(DEPLOYMENTS_DIR);
    } catch {
        return undefined;
    }
    const manifests = entries.filter((f) => f.endsWith("_localnet.json")).sort();
    return manifests.length > 0
        ? path.join(DEPLOYMENTS_DIR, manifests[manifests.length - 1])
        : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy-all E2E (subprocess)", () => {
    let stdout = "";
    let exitHandler: (() => void) | undefined;

    beforeAll(async () => {
        // ── Write minimal .env for Docker Compose ────────────────────
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
        dockerDown(SANDBOX_ROOT);

        // ── Register exit handler to clean up on crash/Ctrl+C ────────
        exitHandler = () => dockerDown(SANDBOX_ROOT);
        process.on("exit", exitHandler);
    }, 300_000);

    // ----------------------------------------------------------------
    // Core: run deploy-all.ts as a subprocess
    // ----------------------------------------------------------------
    test("deploy-all completes successfully", async () => {
        const tsxBin = path.join(SANDBOX_ROOT, "node_modules", ".bin", "tsx");
        const scriptPath = path.join(SANDBOX_ROOT, "scripts", "deploy-all.ts");

        const exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(tsxBin, [scriptPath], {
                cwd: SANDBOX_ROOT,
                env: { ...process.env, FORCE_COLOR: "0" },
                stdio: ["ignore", "pipe", "pipe"],
            });

            child.stdout.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                process.stdout.write(text);
            });

            child.stderr.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                process.stderr.write(text);
            });

            child.on("error", reject);
            child.on("close", (code) => resolve(code ?? 1));
        });

        const tail = stdout.slice(-1000);
        expect(exitCode, `deploy-all.ts exited with code ${exitCode}.\nOutput tail:\n${tail}`).toBe(0);
        expect(stdout, `stdout does not contain success marker.\nOutput tail:\n${tail}`).toContain("DeepBook Sandbox Ready!");
    }, 1_800_000);

    // ----------------------------------------------------------------
    // Validate: deployment manifest
    // ----------------------------------------------------------------
    test("deployment manifest is valid", async () => {
        const manifestPath = await findManifest();
        expect(manifestPath, "no *_localnet.json found in deployments/").toBeDefined();

        const raw = await fs.readFile(manifestPath!, "utf-8");
        const manifest = JSON.parse(raw);

        // Network
        expect(manifest.network.type).toBe("localnet");

        // 5 packages
        const pkgNames = Object.keys(manifest.packages).sort();
        expect(pkgNames).toEqual([
            "deepbook",
            "deepbook_margin",
            "margin_liquidation",
            "pyth",
            "token",
        ]);

        // All packageIds should be valid Sui IDs
        for (const name of pkgNames) {
            expectValidSuiId(manifest.packages[name].packageId);
        }

        // Pool
        expect(manifest.pool.poolId).toBeTruthy();
        expectValidSuiId(manifest.pool.poolId);

        // Pyth oracles
        expect(manifest.pythOracles).toBeDefined();
        expectValidSuiId(manifest.pythOracles.deepPriceInfoObjectId);
        expectValidSuiId(manifest.pythOracles.suiPriceInfoObjectId);

        // Deployer address
        expect(manifest.deployerAddress).toBeTruthy();
    }, 10_000);

    // ----------------------------------------------------------------
    // Validate: .env has expected variables
    // ----------------------------------------------------------------
    test(".env has expected variables", async () => {
        const envContent = await fs.readFile(ENV_PATH, "utf-8");

        const requiredKeys = [
            "PRIVATE_KEY",
            "DEEPBOOK_PACKAGE_ID",
            "DEEP_TOKEN_PACKAGE_ID",
            "DEEP_TREASURY_ID",
            "PYTH_PACKAGE_ID",
            "DEEP_PRICE_INFO_OBJECT_ID",
            "SUI_PRICE_INFO_OBJECT_ID",
            "FIRST_CHECKPOINT",
            "CORE_PACKAGES",
        ];

        for (const key of requiredKeys) {
            expect(envContent, `missing ${key} in .env`).toContain(`${key}=`);
        }
    }, 10_000);

    // ----------------------------------------------------------------
    // E2E: Faucet distributes SUI
    // ----------------------------------------------------------------
    test("faucet distributes SUI", async () => {
        const freshKeypair = Ed25519Keypair.generate();
        const freshAddress = freshKeypair.getPublicKey().toSuiAddress();

        const res = await fetch("http://127.0.0.1:9009/faucet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: freshAddress, token: "SUI" }),
        });
        expect(res.status).toBe(200);

        // Wait for tx to settle
        await new Promise((r) => setTimeout(r, 3_000));

        const client = new SuiClient({ url: RPC_URL });
        const { totalBalance } = await client.getBalance({ owner: freshAddress });
        expect(BigInt(totalBalance)).toBeGreaterThan(0n);
    }, 30_000);

    // ----------------------------------------------------------------
    // E2E: Oracle service reports prices
    // ----------------------------------------------------------------
    test("oracle service reports prices", async () => {
        // Give the oracle time to perform at least one update cycle
        await new Promise((r) => setTimeout(r, 15_000));

        const res = await fetch("http://127.0.0.1:9010/");
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toBeDefined();
        expect(body.status).toBeDefined();
    }, 60_000);

    // ----------------------------------------------------------------
    // E2E: Market maker is healthy
    // ----------------------------------------------------------------
    test("market maker is healthy", async () => {
        const deadline = Date.now() + 150_000;
        let lastStatus = 0;
        while (Date.now() < deadline) {
            try {
                const res = await fetch("http://127.0.0.1:3001/health");
                lastStatus = res.status;
                if (res.status === 200) break;
            } catch {
                // connection refused — keep polling
            }
            await new Promise((r) => setTimeout(r, 3_000));
        }
        expect(lastStatus).toBe(200);
    }, 180_000);

    // ----------------------------------------------------------------
    // E2E: Pool exists on-chain
    // ----------------------------------------------------------------
    test("pool exists on-chain", async () => {
        const manifestPath = await findManifest();
        expect(manifestPath).toBeDefined();

        const manifest = JSON.parse(await fs.readFile(manifestPath!, "utf-8"));
        const poolId: string = manifest.pool.poolId;

        const client = new SuiClient({ url: RPC_URL });
        const poolObj = await client.getObject({
            id: poolId,
            options: { showType: true },
        });

        expect(poolObj.data).toBeDefined();
        expect(poolObj.data!.type).toContain("::pool::Pool<");
    }, 30_000);

    // ----------------------------------------------------------------
    // Cleanup
    // ----------------------------------------------------------------
    afterAll(async () => {
        // Tear down containers
        dockerDown(SANDBOX_ROOT);

        // Remove test .env and shared keystore
        for (const f of [ENV_PATH, path.join(DEPLOYMENTS_DIR, ".sui-keystore")]) {
            try {
                await fs.unlink(f);
            } catch {
                // may not exist
            }
        }

        // Remove test deployment manifests
        try {
            const entries = await fs.readdir(DEPLOYMENTS_DIR);
            for (const entry of entries) {
                if (entry.endsWith("_localnet.json")) {
                    await fs.unlink(path.join(DEPLOYMENTS_DIR, entry));
                }
            }
        } catch {
            // deployments dir may not exist
        }

        // Deregister exit handler
        if (exitHandler) {
            process.removeListener("exit", exitHandler);
            exitHandler = undefined;
        }
    }, 300_000);
});

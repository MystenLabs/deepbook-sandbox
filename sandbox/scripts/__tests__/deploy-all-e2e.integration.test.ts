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
const ENV_FILE = ".env.test";
const ENV_PATH = path.join(SANDBOX_ROOT, ENV_FILE);

const RPC_URL = "http://127.0.0.1:9000";

// ---------------------------------------------------------------------------
// Docker cleanup helper
// ---------------------------------------------------------------------------

function dockerDown(cwd: string): void {
    const envFileArgs = process.env.SANDBOX_ENV_FILE
        ? ["--env-file", process.env.SANDBOX_ENV_FILE]
        : [];
    spawnSync(
        "docker",
        ["compose", ...envFileArgs, "--profile", "localnet", "down", "-v", "--remove-orphans"],
        { cwd, encoding: "utf-8", stdio: "inherit" },
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a KEY=VALUE from .env content. Returns the value or undefined. */
function parseEnvValue(envContent: string, key: string): string | undefined {
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy-all E2E (subprocess)", () => {
    let stdout = "";
    let exitHandler: (() => void) | undefined;

    beforeAll(async () => {
        // ── Route all env file I/O to .env.test (keeps user's .env untouched) ──
        process.env.SANDBOX_ENV_FILE = ENV_FILE;

        // ── Write minimal .env.test for Docker Compose ───────────────
        // NOTE: No PRIVATE_KEY here — deploy-all.ts generates a placeholder
        // for docker compose validation, then reads the container-generated
        // key in Phase 1 (localnet always uses the container key when no
        // user-supplied key exists).
        const envContent =
            [
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

        // Verify tsx binary and script exist before spawning
        const tsxExists = await fs.access(tsxBin).then(
            () => true,
            () => false,
        );
        expect(tsxExists, `tsx binary not found at ${tsxBin}`).toBe(true);
        const scriptExists = await fs.access(scriptPath).then(
            () => true,
            () => false,
        );
        expect(scriptExists, `deploy-all.ts not found at ${scriptPath}`).toBe(true);

        let stderr = "";
        const exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(tsxBin, [scriptPath, "--quick"], {
                cwd: SANDBOX_ROOT,
                env: {
                    ...process.env,
                    FORCE_COLOR: "0",
                    SANDBOX_ENV_FILE: ENV_FILE,
                    DOTENV_CONFIG_PATH: ENV_PATH,
                },
                stdio: ["ignore", "pipe", "pipe"],
            });

            console.log(`[e2e] spawned pid=${child.pid} — ${tsxBin} ${scriptPath}`);

            child.stdout.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                process.stdout.write(text);
            });

            child.stderr.on("data", (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                stderr += text;
                process.stderr.write(text);
            });

            child.on("error", reject);
            child.on("close", (code, signal) => {
                console.log(
                    `[e2e] process closed: code=${code} signal=${signal} stdout=${stdout.length}B stderr=${stderr.length}B`,
                );
                resolve(code ?? 1);
            });
        });

        const tail = stdout.slice(-2000);
        const stderrTail = stderr.slice(-1000);
        const diagMsg = [
            `deploy-all.ts exited with code ${exitCode}.`,
            `stdout length: ${stdout.length}B, stderr length: ${stderr.length}B`,
            `\n--- stdout tail (last 2000 chars) ---\n${tail}`,
            stderrTail ? `\n--- stderr tail (last 1000 chars) ---\n${stderrTail}` : "",
        ].join("\n");

        expect(exitCode, diagMsg).toBe(0);
        expect(stdout, `stdout does not contain success marker.\n${diagMsg}`).toContain(
            "DeepBook Sandbox Ready!",
        );
    }, 1_800_000);

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
            "DEEPBOOK_MARGIN_PACKAGE_ID",
            "PYTH_PACKAGE_ID",
            "DEEP_PRICE_INFO_OBJECT_ID",
            "SUI_PRICE_INFO_OBJECT_ID",
            "USDC_PRICE_INFO_OBJECT_ID",
            "ORACLE_PRIVATE_KEY",
            "FIRST_CHECKPOINT",
            "CORE_PACKAGES",
            "MARGIN_PACKAGES",
            "POOL_ID",
            "BASE_COIN_TYPE",
            "DEPLOYER_ADDRESS",
        ];

        for (const key of requiredKeys) {
            expect(envContent, `missing ${key} in .env`).toContain(`${key}=`);
        }

        // Critical IDs should be valid Sui addresses
        const suiIdKeys = [
            "DEEPBOOK_PACKAGE_ID",
            "DEEP_TOKEN_PACKAGE_ID",
            "DEEP_TREASURY_ID",
            "DEEPBOOK_MARGIN_PACKAGE_ID",
            "PYTH_PACKAGE_ID",
            "DEEP_PRICE_INFO_OBJECT_ID",
            "SUI_PRICE_INFO_OBJECT_ID",
            "USDC_PRICE_INFO_OBJECT_ID",
            "POOL_ID",
        ];
        for (const key of suiIdKeys) {
            const value = parseEnvValue(envContent, key);
            expect(value, `${key} is empty`).toBeTruthy();
            expectValidSuiId(value!);
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
            signal: AbortSignal.timeout(30_000),
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

        const res = await fetch("http://127.0.0.1:9010/", { signal: AbortSignal.timeout(30_000) });
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
                const res = await fetch("http://127.0.0.1:3001/health", {
                    signal: AbortSignal.timeout(10_000),
                });
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
    // E2E: Indexer is healthy
    // ----------------------------------------------------------------
    test("indexer metrics endpoint responds", async () => {
        const res = await waitForUrl("http://127.0.0.1:9184/metrics", {
            timeoutMs: 120_000,
            label: "deepbook-indexer",
        });
        expect(res.status).toBe(200);
    }, 150_000);

    // ----------------------------------------------------------------
    // E2E: DeepBook server is healthy
    // ----------------------------------------------------------------
    test("deepbook server responds", async () => {
        const res = await waitForUrl("http://127.0.0.1:9008/", {
            timeoutMs: 60_000,
            label: "deepbook-server",
        });
        expect(res.status).toBe(200);
    }, 90_000);

    // ----------------------------------------------------------------
    // E2E: DEEP/SUI pool exists on-chain
    // ----------------------------------------------------------------
    test("DEEP/SUI pool exists on-chain", async () => {
        const envContent = await fs.readFile(ENV_PATH, "utf-8");
        const poolId = parseEnvValue(envContent, "POOL_ID");
        expect(poolId, "POOL_ID not found in .env").toBeTruthy();

        const client = new SuiClient({ url: RPC_URL });
        const poolObj = await client.getObject({
            id: poolId!,
            options: { showType: true },
        });

        expect(poolObj.data).toBeDefined();
        expect(poolObj.data!.type).toContain("::pool::Pool<");
    }, 30_000);

    // ----------------------------------------------------------------
    // Completeness guard: every localnet-profile service must be running.
    // If a new service is added to the localnet profile in
    // docker-compose.yml, this test fails until deploy-all.ts starts it
    // and a health check test is added above.
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
        dockerDown(SANDBOX_ROOT);

        // Remove .env.test and reset routing
        try {
            await fs.unlink(ENV_PATH);
        } catch {
            /* may not exist */
        }
        delete process.env.SANDBOX_ENV_FILE;

        // Remove shared keystore
        const deploymentsDir = path.join(SANDBOX_ROOT, "deployments");
        try {
            await fs.unlink(path.join(deploymentsDir, ".sui-keystore"));
        } catch {
            // may not exist
        }

        // Deregister exit handler
        if (exitHandler) {
            process.removeListener("exit", exitHandler);
            exitHandler = undefined;
        }
    }, 300_000);
});

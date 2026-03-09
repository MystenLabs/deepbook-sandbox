import { spawnSync, execFileSync, type SpawnSyncReturns } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import log from "./logger";

/**
 * Return the env filename to use for Docker Compose and env file I/O.
 * Defaults to ".env"; tests set SANDBOX_ENV_FILE=".env.test" so the
 * user's real .env is never touched.
 */
export function getEnvFileName(): string {
    return process.env.SANDBOX_ENV_FILE || ".env";
}

/**
 * Run a docker compose command with visible output (logged via project logger).
 *
 * IMPORTANT: Uses `stdio: ["inherit", "pipe", "pipe"]` instead of `"inherit"`
 * to avoid sharing pipe file descriptors with Docker compose child processes.
 * When this module runs inside a subprocess with piped stdio (e.g. the e2e test
 * spawns `tsx deploy-all.ts` with `stdio: ["ignore", "pipe", "pipe"]`), using
 * `stdio: "inherit"` causes Docker compose to inherit the parent's pipe fds.
 * When Docker exits it closes those fds, which corrupts Node.js's internal
 * handle tracking and causes the event loop to drain — exiting the process
 * with code 0 before async work (like waitForRpc) completes.
 */
function runDockerComposeVisible(
    args: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv },
): SpawnSyncReturns<string> {
    const envFile = getEnvFileName();
    const envFileArgs = envFile !== ".env" ? ["--env-file", envFile] : [];
    const result = spawnSync("docker", ["compose", ...envFileArgs, ...args], {
        cwd: opts.cwd,
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "pipe"],
        env: opts.env,
    });
    // Forward captured output through the logger
    if (result.stdout?.trim()) {
        for (const line of result.stdout.trim().split("\n")) {
            log.info(line);
        }
    }
    if (result.stderr?.trim()) {
        // Docker compose writes progress to stderr even on success
        for (const line of result.stderr.trim().split("\n")) {
            log.info(line);
        }
    }
    return result;
}

/** Default RPC and faucet ports for localnet (from docker-compose). */
export const LOCALNET_RPC_PORT = 9000;
export const LOCALNET_FAUCET_PORT = 9123;

/** DeepBook server REST API port (remote profile). */
export const DEEPBOOK_SERVER_PORT = 9008;

/**
 * Resolve the sandbox root directory (where docker-compose.yml lives).
 * Works when running from sandbox/ or from project root.
 */
export function getSandboxRoot(): string {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    // scripts/utils -> sandbox
    return path.resolve(scriptDir, "../..");
}

/**
 * Start localnet with docker compose (profile localnet) and wait until RPC is ready.
 * Runs from sandbox root: `docker compose --profile localnet up -d sui-localnet postgres`, then polls RPC.
 * Note: Explicit service names prevent the indexer from starting prematurely.
 */
export async function startLocalnet(sandboxRoot?: string): Promise<{
    rpcPort: number;
    faucetPort: number;
}> {
    const cwd = sandboxRoot ?? getSandboxRoot();
    const result = runDockerComposeVisible(
        ["--profile", "localnet", "up", "-d", "sui-localnet", "postgres"],
        { cwd },
    );
    if (result.status !== 0) {
        const stderr = result.stderr?.trim() || "";
        throw new Error(
            `docker compose failed (exit ${result.status}). Ensure Docker is running and SUI_TOOLS_IMAGE is set in .env.${stderr ? `\n${stderr}` : ""}`,
        );
    }
    log.info("docker compose up -d returned successfully");

    // Verify container is running before polling RPC (catches immediate crashes)
    let containerNotRunning = false;
    try {
        const running = execFileSync(
            "docker",
            ["inspect", "-f", "{{.State.Running}}", "sui-localnet"],
            { encoding: "utf-8" },
        ).trim();
        containerNotRunning = running !== "true";
        log.info(`Container check: sui-localnet Running=${running}`);
    } catch {
        log.warn("docker inspect failed (container may not exist yet)");
        // docker inspect might fail if container doesn't exist yet — continue to waitForRpc
    }
    if (containerNotRunning) {
        const logs = spawnSync("docker", ["logs", "--tail", "50", "sui-localnet"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        throw new Error(
            `sui-localnet container is not running.\nLogs:\n${logs.stdout || logs.stderr}`,
        );
    }

    log.info("Waiting for RPC to become ready...");
    await waitForRpc(`http://127.0.0.1:${LOCALNET_RPC_PORT}`);
    log.info("RPC ready, waiting for faucet...");
    await waitForFaucet(`http://127.0.0.1:${LOCALNET_FAUCET_PORT}`);
    log.info("Faucet ready");
    return { rpcPort: LOCALNET_RPC_PORT, faucetPort: LOCALNET_FAUCET_PORT };
}

/**
 * Start deepbook-indexer and server with docker compose (profile remote).
 * Runs from sandbox root. Pass envOverlay to inject deployment IDs into the compose
 * process so containers get the correct values (Docker Compose substitutes from process env).
 * Uses --force-recreate so containers are recreated with the new env.
 */
export async function startRemote(
    sandboxRoot?: string,
    envOverlay?: Record<string, string>,
): Promise<{ serverPort: number }> {
    const cwd = sandboxRoot ?? getSandboxRoot();
    const env = envOverlay ? { ...process.env, ...envOverlay } : process.env;
    const result = runDockerComposeVisible(
        ["--profile", "remote", "up", "-d", "--force-recreate"],
        { cwd, env },
    );
    if (result.status !== 0) {
        const stderr = result.stderr?.trim() || "";
        throw new Error(
            `docker compose --profile remote failed (exit ${result.status}). Ensure Docker is running.${stderr ? `\n${stderr}` : ""}`,
        );
    }
    await waitForServer(`http://127.0.0.1:${DEEPBOOK_SERVER_PORT}`);
    return { serverPort: DEEPBOOK_SERVER_PORT };
}

async function waitForServer(baseUrl: string, maxAttempts = 90): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/`;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (res.status > 0) return;
        } catch {
            // connection refused, timeout, or similar
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`DeepBook server at ${url} did not become ready after ${maxAttempts} attempts`);
}

async function waitForRpc(url: string, maxAttempts = 60): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (res.status > 0) return; // any HTTP response means server is up
        } catch {
            // connection refused, timeout, or similar
        }
        if (i === 0 || (i + 1) % 10 === 0) {
            log.info(`waitForRpc attempt ${i + 1}/${maxAttempts} — ${url} not ready yet`);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`RPC at ${url} did not become ready after ${maxAttempts} attempts`);
}

async function waitForFaucet(baseUrl: string, maxAttempts = 30): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/v2/gas`;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
                signal: AbortSignal.timeout(10_000),
            });
            if (res.status > 0) return; // any response (e.g. 400 for bad body) means faucet is up
        } catch {
            // connection refused, timeout, or ECONNRESET
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Faucet at ${baseUrl} did not become ready after ${maxAttempts} attempts`);
}

/**
 * Start the localnet indexer with dynamically deployed package addresses.
 * Writes package IDs to .env and starts the indexer container.
 */
export async function configureAndStartLocalnetServices(
    packages: { corePackageId: string; marginPackageId?: string },
    sandboxRoot?: string,
): Promise<void> {
    const cwd = sandboxRoot ?? getSandboxRoot();
    const envPath = path.join(cwd, getEnvFileName());

    // Read existing env content (preserve other variables like SUI_TOOLS_IMAGE)
    let envContent = "";
    try {
        envContent = await fs.readFile(envPath, "utf-8");
    } catch {
        // env file doesn't exist yet, that's fine
    }

    // Update or add CORE_PACKAGES and MARGIN_PACKAGES
    const envLines = envContent.split("\n").filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("CORE_PACKAGES=") && !trimmed.startsWith("MARGIN_PACKAGES=");
    });

    envLines.push(`CORE_PACKAGES=${packages.corePackageId}`);
    if (packages.marginPackageId) {
        envLines.push(`MARGIN_PACKAGES=${packages.marginPackageId}`);
    }

    await fs.writeFile(envPath, envLines.filter(Boolean).join("\n") + "\n");

    // Start the indexer (explicit service name to avoid starting other localnet services)
    // --force-recreate ensures containers pick up new env vars on re-deploys.
    // We intentionally omit --build: Rust services (indexer, server) are
    // pull-only from Docker Hub; Node.js services auto-build when needed.
    const result = runDockerComposeVisible(
        [
            "--profile",
            "localnet",
            "up",
            "-d",
            "--build",
            "--force-recreate",
            "deepbook-indexer",
            "deepbook-server",
            "deepbook-faucet",
        ],
        { cwd },
    );

    if (result.status !== 0) {
        const stderr = result.stderr?.trim() || "";
        throw new Error(
            `Failed to start localnet indexer (exit ${result.status})${stderr ? `\n${stderr}` : ""}`,
        );
    }

    // Wait for indexer to be healthy (check metrics endpoint)
    await waitForIndexer("http://127.0.0.1:9184/metrics");
}

/**
 * Start the oracle service container.
 * Reads pyth oracle IDs from the .env file (via Docker Compose env substitution).
 * Uses --force-recreate so the container picks up the latest env values.
 */
export async function startOracleService(
    sandboxRoot?: string,
    envOverlay?: Record<string, string>,
): Promise<void> {
    const cwd = sandboxRoot ?? getSandboxRoot();
    const env = envOverlay ? { ...process.env, ...envOverlay } : process.env;
    const result = runDockerComposeVisible(
        ["--profile", "localnet", "up", "-d", "--force-recreate", "oracle-service"],
        { cwd, env },
    );
    if (result.status !== 0) {
        const stderr = result.stderr?.trim() || "";
        throw new Error(
            `Failed to start oracle service (exit ${result.status})${stderr ? `\n${stderr}` : ""}`,
        );
    }
}

/**
 * Start the market maker container.
 * Reads pool/package IDs from the .env file (via Docker Compose env substitution).
 * Uses --force-recreate so the container picks up the latest env values.
 */
export async function startMarketMaker(
    sandboxRoot?: string,
    envOverlay?: Record<string, string>,
): Promise<void> {
    const cwd = sandboxRoot ?? getSandboxRoot();
    const env = envOverlay ? { ...process.env, ...envOverlay } : process.env;
    const result = runDockerComposeVisible(
        ["--profile", "localnet", "up", "-d", "--force-recreate", "market-maker"],
        { cwd, env },
    );
    if (result.status !== 0) {
        const stderr = result.stderr?.trim() || "";
        throw new Error(
            `Failed to start market maker (exit ${result.status})${stderr ? `\n${stderr}` : ""}`,
        );
    }
}

async function waitForIndexer(url: string, maxAttempts = 60): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (res.ok) return;
        } catch {
            // connection refused, timeout, or similar
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Indexer at ${url} did not become ready after ${maxAttempts} attempts`);
}

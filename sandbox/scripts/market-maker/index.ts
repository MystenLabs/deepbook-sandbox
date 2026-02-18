import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { getClient, getSigner } from "../utils/config";
import { loadConfig, parseEnvConfig } from "./config";
import type { DeploymentManifest } from "./types";
import { explorerObjectUrl } from "./types";
import { MarketMaker } from "./market-maker";
import log from "../utils/logger";

async function findLatestDeployment(): Promise<string> {
    const deploymentsDir = path.join(process.cwd(), "deployments");

    try {
        const files = await fs.readdir(deploymentsDir);
        const jsonFiles = files.filter((f) => f.endsWith(".json"));

        if (jsonFiles.length === 0) {
            throw new Error("No deployment files found. Run `pnpm deploy-all` first.");
        }

        // Sort by name (which includes timestamp) to get latest
        jsonFiles.sort().reverse();
        return path.join(deploymentsDir, jsonFiles[0]);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("Deployments directory not found. Run `pnpm deploy-all` first.");
        }
        throw error;
    }
}

async function loadDeployment(deploymentPath?: string): Promise<DeploymentManifest> {
    const filePath = deploymentPath || (await findLatestDeployment());
    log.info(`Loading deployment from: ${filePath}`);

    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as DeploymentManifest;
}

async function main() {
    log.banner("DeepBook V3 Market Maker");

    // Load deployment manifest
    const deploymentPath = process.env.DEPLOYMENT_PATH;
    const manifest = await loadDeployment(deploymentPath);

    const network = manifest.network.type;
    log.detail(`Network: ${network}`);
    log.detail(`Pool: ${manifest.pool.poolId}`);
    log.detail(explorerObjectUrl(manifest.pool.poolId, network));
    log.detail(`Package: ${manifest.packages.deepbook.packageId}`);

    // Load configuration
    const envConfig = parseEnvConfig();
    const config = loadConfig(envConfig);

    log.detail(
        `Spread: ${config.spreadBps} bps | Levels: ${config.levelsPerSide}/side | Order: ${Number(config.orderSizeBase) / 1e6} DEEP`,
    );
    log.detail(`Rebalance: ${config.rebalanceIntervalMs}ms`);

    // Create Sui client and signer
    const client = getClient();
    const signer = getSigner();
    const signerAddress = signer.getPublicKey().toSuiAddress();
    log.detail(`Signer: ${signerAddress}`);

    // Create and initialize market maker
    const marketMaker = new MarketMaker({
        client,
        signer,
        manifest,
        config,
    });

    // Setup graceful shutdown
    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        await marketMaker.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Initialize and start
    try {
        await marketMaker.initialize();
        await marketMaker.start();

        // Keep the process running
        log.info("Market maker running. Press Ctrl+C to stop.");
    } catch (error) {
        log.fail("Fatal error");
        log.loopError("", error);
        await marketMaker.stop();
        process.exit(1);
    }
}

main().catch((error) => {
    log.fail("Unhandled error");
    log.loopError("", error);
    process.exit(1);
});

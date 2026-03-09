import "dotenv/config";
import { getClient, getNetwork, getSigner } from "../utils/config";
import { loadConfig, parseEnvConfig } from "./config";
import type { DeploymentManifest, PoolConfig } from "./types";
import { explorerObjectUrl, parsePoolConfigs, pairLabel } from "./types";
import { MarketMaker } from "./market-maker";
import log from "../utils/logger";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing required environment variable: ${name}. Run \`pnpm deploy-all\` first.`,
        );
    }
    return value;
}

/**
 * Build pool configs from the MM_POOLS JSON env var,
 * or fall back to legacy single-pool env vars for backward compatibility.
 */
function loadPoolConfigs(): PoolConfig[] {
    const mmPoolsJson = process.env.MM_POOLS;
    if (mmPoolsJson) {
        return parsePoolConfigs(mmPoolsJson);
    }

    // Legacy single-pool fallback
    const poolId = requireEnv("POOL_ID");
    const baseCoinType = requireEnv("BASE_COIN_TYPE");

    return [
        {
            poolId,
            baseCoinType,
            quoteCoinType: "0x2::sui::SUI",
            basePriceInfoObjectId: process.env.DEEP_PRICE_INFO_OBJECT_ID,
            quotePriceInfoObjectId: process.env.SUI_PRICE_INFO_OBJECT_ID,
            tickSize: 1_000_000n,
            lotSize: 1_000_000n,
            minSize: 10_000_000n,
            orderSizeBase: 10_000_000n,
            fallbackMidPrice: 100_000_000n,
            baseDepositAmount: 1_000_000_000n,
            quoteDepositAmount: 10_000_000_000n,
            baseDecimals: 6,
            quoteDecimals: 9,
        },
    ];
}

function loadManifestFromEnv(): DeploymentManifest {
    const network = getNetwork() as "localnet" | "testnet";
    const deepbookPackageId = requireEnv("DEEPBOOK_PACKAGE_ID");
    const deployerAddress = requireEnv("DEPLOYER_ADDRESS");

    const pythPackageId = process.env.PYTH_PACKAGE_ID;

    const pools = loadPoolConfigs();

    return {
        network: {
            type: network,
            rpcUrl: process.env.RPC_URL ?? "",
            faucetUrl: "",
        },
        packages: {
            deepbook: {
                packageId: deepbookPackageId,
                objects: [],
                transactionDigest: "",
            },
            ...(pythPackageId && {
                pyth: {
                    packageId: pythPackageId,
                    objects: [],
                    transactionDigest: "",
                },
            }),
        },
        pools,
        deploymentTime: "",
        deployerAddress,
    };
}

async function main() {
    log.banner("DeepBook V3 Market Maker");

    // Build manifest from environment variables
    const manifest = loadManifestFromEnv();

    const network = manifest.network.type;
    log.detail(`Network: ${network}`);
    log.detail(`Package: ${manifest.packages.deepbook.packageId}`);
    log.detail(`Pools: ${manifest.pools.length}`);
    for (const pool of manifest.pools) {
        const label = pairLabel(pool.baseCoinType, pool.quoteCoinType);
        log.detail(`  ${label}: ${pool.poolId}`);
        log.detail(`  ${explorerObjectUrl(pool.poolId, network)}`);
    }

    // Load configuration
    const envConfig = parseEnvConfig();
    const config = loadConfig(envConfig);

    log.detail(`Spread: ${config.spreadBps} bps | Levels: ${config.levelsPerSide}/side`);
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

import http from "http";
import { getClient, getNetwork, getSigner } from "../utils/config";
import { PythClient } from "./pyth-client";
import { OracleUpdater } from "./oracle-updater";
import type { OracleConfig, ParsedPriceData } from "./types";
import { DEEP_PRICE_FEED_ID, SUI_PRICE_FEED_ID } from "./constants";
import log from "../utils/logger";

/**
 * Oracle Service - Updates Pyth price feeds on localnet
 *
 * This service:
 * 1. Fetches historical price data from Pyth Network API every 10 seconds
 * 2. Updates the SUI and DEEP PriceInfoObjects on-chain
 * 3. Exposes a health/status endpoint on port 9010
 *
 * Required env vars:
 *   PYTH_PACKAGE_ID, DEEP_PRICE_INFO_OBJECT_ID, SUI_PRICE_INFO_OBJECT_ID
 */

const STATUS_PORT = 9010;

const DEFAULT_CONFIG: OracleConfig = {
    pythApiUrl: "https://benchmarks.pyth.network",
    priceFeeds: {
        sui: SUI_PRICE_FEED_ID,
        deep: DEEP_PRICE_FEED_ID,
    },
    updateIntervalMs: 10000, // 10 seconds
    historicalDataHours: 24, // Fetch data from 24 hours ago
};

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

/** Shared state for the status endpoint */
const status = {
    updateCount: 0,
    errorCount: 0,
    lastUpdateTime: null as string | null,
    lastSuiPrice: null as string | null,
    lastDeepPrice: null as string | null,
};

function formatPrice(price: string, expo: number): string {
    const priceNum = Number.parseInt(price);
    const formatted = priceNum * Math.pow(10, expo);
    return formatted.toFixed(Math.abs(expo));
}

function updateStatus(suiData: ParsedPriceData, deepData: ParsedPriceData) {
    status.lastUpdateTime = new Date().toISOString();
    status.lastSuiPrice = formatPrice(suiData.price.price, suiData.price.expo);
    status.lastDeepPrice = formatPrice(deepData.price.price, deepData.price.expo);
}

function startStatusServer() {
    const server = http.createServer((req, res) => {
        const path = req.url?.split("?")[0] ?? "";
        const isStatusPath = path === "/" || path === "/status";

        if (!isStatusPath) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not Found" }, null, 2));
            return;
        }
        if (req.method !== "GET") {
            res.writeHead(405, {
                "Content-Type": "application/json",
                Allow: "GET",
            });
            res.end(JSON.stringify({ error: "Method Not Allowed" }, null, 2));
            return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify(
                {
                    status: "ok",
                    updates: status.updateCount,
                    errors: status.errorCount,
                    lastUpdate: status.lastUpdateTime,
                    prices: {
                        sui: status.lastSuiPrice ? `$${status.lastSuiPrice}` : null,
                        deep: status.lastDeepPrice ? `$${status.lastDeepPrice}` : null,
                    },
                },
                null,
                2,
            ),
        );
    });
    server.listen(STATUS_PORT, () => {
        log.success(`Status endpoint: http://localhost:${STATUS_PORT}`);
    });
}

async function main() {
    log.banner("Oracle Service");

    const network = getNetwork();
    if (network !== "localnet") {
        throw new Error(
            "Oracle service is only supported on localnet. Current network: " + network,
        );
    }

    const pythPackageId = requireEnv("PYTH_PACKAGE_ID");
    const deepPriceInfoObjectId = requireEnv("DEEP_PRICE_INFO_OBJECT_ID");
    const suiPriceInfoObjectId = requireEnv("SUI_PRICE_INFO_OBJECT_ID");

    log.detail(`Network: ${network}`);
    log.detail(`Pyth Package: ${pythPackageId}`);
    log.detail(`SUI Oracle: ${suiPriceInfoObjectId}`);
    log.detail(`DEEP Oracle: ${deepPriceInfoObjectId}`);
    log.detail(`Update Interval: ${DEFAULT_CONFIG.updateIntervalMs / 1000}s`);

    // Initialize clients
    const client = getClient(network);
    const signer = getSigner();
    const pythClient = new PythClient(DEFAULT_CONFIG);
    const oracleUpdater = new OracleUpdater(client, signer, pythPackageId);

    // Test connection
    try {
        const chainId = await client.getChainIdentifier();
        log.success(`Connected to chain: ${chainId}`);
    } catch (error) {
        throw new Error(`Failed to connect to Sui RPC: ${error}`);
    }

    // Start status/health endpoint
    startStatusServer();

    log.phase("Starting price feed updates");

    // Update loop
    const updatePrices = async () => {
        try {
            const startTime = Date.now();

            // Fetch price data from Pyth
            const priceUpdate = await pythClient.fetchPriceUpdates();

            // Find SUI and DEEP data for status tracking
            const suiData = priceUpdate.parsed.find((p) => p.id === SUI_PRICE_FEED_ID.slice(2));
            const deepData = priceUpdate.parsed.find((p) => p.id === DEEP_PRICE_FEED_ID.slice(2));

            // Update on-chain oracles
            await oracleUpdater.updatePriceFeeds(priceUpdate.parsed, {
                sui: suiPriceInfoObjectId,
                deep: deepPriceInfoObjectId,
            });

            status.updateCount++;
            if (suiData && deepData) updateStatus(suiData, deepData);

            const elapsed = Date.now() - startTime;
            log.loopSuccess(
                `Update #${status.updateCount} completed in ${elapsed}ms (errors: ${status.errorCount})`,
            );
        } catch (error) {
            status.errorCount++;
            log.loopError(`Update failed (error #${status.errorCount})`, error);
        }
    };

    // Initial update
    await updatePrices();

    // Schedule periodic updates
    setInterval(updatePrices, DEFAULT_CONFIG.updateIntervalMs);

    // Keep process alive
    log.info("Oracle service is running. Press Ctrl+C to stop.");
}

// Handle graceful shutdown
process.on("SIGINT", () => {
    log.warn("Shutting down oracle service...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    log.warn("Shutting down oracle service...");
    process.exit(0);
});

// Start service
main().catch((error) => {
    log.fail("Oracle service failed");
    log.loopError("", error);
    process.exit(1);
});

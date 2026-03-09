import http from "http";
import type { ParsedPriceData } from "./types";
import { formatPrice } from "./format-price";

/**
 * Shared mutable state read by the HTTP status endpoint
 * and written by the update loop.
 */
export interface OracleStatus {
    updateCount: number;
    errorCount: number;
    lastUpdateTime: string | null;
    lastSuiPrice: string | null;
    lastDeepPrice: string | null;
    lastUsdcPrice: string | null;
}

/** Create a fresh zero-state status object. */
export function createInitialStatus(): OracleStatus {
    return {
        updateCount: 0,
        errorCount: 0,
        lastUpdateTime: null,
        lastSuiPrice: null,
        lastDeepPrice: null,
        lastUsdcPrice: null,
    };
}

/** Mutate `status` with the latest price data from Pyth. */
export function updateStatus(
    status: OracleStatus,
    suiData: ParsedPriceData,
    deepData: ParsedPriceData,
    usdcData: ParsedPriceData,
): void {
    status.lastUpdateTime = new Date().toISOString();
    status.lastSuiPrice = formatPrice(suiData.price.price, suiData.price.expo);
    status.lastDeepPrice = formatPrice(deepData.price.price, deepData.price.expo);
    status.lastUsdcPrice = formatPrice(usdcData.price.price, usdcData.price.expo);
}

/**
 * Create an HTTP server that exposes oracle status as JSON.
 *
 * Routes:
 *   GET /        → 200 JSON status
 *   GET /status  → 200 JSON status
 *   Other paths  → 404
 *   Non-GET      → 405
 *
 * The caller is responsible for calling `server.listen(port)`.
 */
export function createStatusServer(status: OracleStatus): http.Server {
    return http.createServer((req, res) => {
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
                        usdc: status.lastUsdcPrice ? `$${status.lastUsdcPrice}` : null,
                    },
                },
                null,
                2,
            ),
        );
    });
}

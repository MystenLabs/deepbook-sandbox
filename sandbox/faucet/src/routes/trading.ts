import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";
import { getMidPrice, getBookParams, getOrderBookDepth } from "../services/trading.js";

const DECIMALS: Record<string, number> = { SUI: 9, DEEP: 6, USDC: 6 };
const ORDER_BOOK_TICKS = 10;

interface PoolInfo {
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
}

interface ManifestData {
    deepbookPackageId: string;
    pools: Record<string, PoolInfo>;
}

function loadManifestSync(): ManifestData | null {
    try {
        const dir = "/app/deployments";
        const files = readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .sort();
        if (files.length === 0) return null;
        const raw = JSON.parse(readFileSync(join(dir, files[files.length - 1]), "utf-8"));

        const pools: Record<string, PoolInfo> = {};
        for (const [key, val] of Object.entries(raw.pools || {})) {
            const p = val as { poolId: string; baseCoinType: string; quoteCoinType: string };
            pools[key] = {
                poolId: p.poolId,
                baseCoinType: p.baseCoinType,
                quoteCoinType: p.quoteCoinType,
            };
        }

        return {
            deepbookPackageId: raw.packages?.deepbook?.packageId,
            pools,
        };
    } catch {
        return null;
    }
}

const poolKeySchema = z.enum(["DEEP_SUI", "SUI_USDC"]);

/** Derive base/quote coin symbols from pool key. */
function poolDecimals(poolKey: string): { baseDecimals: number; quoteDecimals: number } {
    if (poolKey === "DEEP_SUI") return { baseDecimals: DECIMALS.DEEP, quoteDecimals: DECIMALS.SUI };
    return { baseDecimals: DECIMALS.SUI, quoteDecimals: DECIMALS.USDC };
}

export function tradingRoutes(client: SuiGrpcClient, signer: Keypair): Hono {
    const app = new Hono();

    function getManifest(): ManifestData {
        const m = loadManifestSync();
        if (!m) throw new Error("Deployment manifest not found");
        return m;
    }

    function getPool(manifest: ManifestData, poolKey: string): PoolInfo {
        const pool = manifest.pools[poolKey];
        if (!pool) throw new Error(`Pool ${poolKey} not found in manifest`);
        return pool;
    }

    // GET /trading/pool-details/:poolKey
    app.get("/pool-details/:poolKey", async (c) => {
        try {
            const poolKey = poolKeySchema.parse(c.req.param("poolKey"));
            const manifest = getManifest();
            const pool = getPool(manifest, poolKey);
            const sender = signer.getPublicKey().toSuiAddress();
            const { baseDecimals, quoteDecimals } = poolDecimals(poolKey);
            const baseScalar = 10 ** baseDecimals;
            const quoteScalar = 10 ** quoteDecimals;

            const [midPriceRaw, bookParams, depth] = await Promise.all([
                getMidPrice(
                    client,
                    sender,
                    manifest.deepbookPackageId,
                    pool.poolId,
                    pool.baseCoinType,
                    pool.quoteCoinType,
                ),
                getBookParams(
                    client,
                    sender,
                    manifest.deepbookPackageId,
                    pool.poolId,
                    pool.baseCoinType,
                    pool.quoteCoinType,
                ),
                getOrderBookDepth(
                    client,
                    sender,
                    manifest.deepbookPackageId,
                    pool.poolId,
                    pool.baseCoinType,
                    pool.quoteCoinType,
                    ORDER_BOOK_TICKS,
                ),
            ]);

            const formatPrice = (raw: bigint) => (Number(raw) / quoteScalar).toString();
            const formatQty = (raw: bigint) => (Number(raw) / baseScalar).toString();

            const bids = depth.bidPrices.map((price, i) => ({
                price: formatPrice(price),
                quantity: formatQty(depth.bidQuantities[i]),
            }));

            const asks = depth.askPrices.map((price, i) => ({
                price: formatPrice(price),
                quantity: formatQty(depth.askQuantities[i]),
            }));

            return c.json({
                success: true,
                midPrice: formatPrice(midPriceRaw),
                tickSize: formatPrice(bookParams.tickSize),
                lotSize: formatQty(bookParams.lotSize),
                minSize: formatQty(bookParams.minSize),
                bids,
                asks,
            });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    return app;
}

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { SuiClient } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";
import {
    createBalanceManager,
    deposit,
    withdraw,
    getBalance,
    placeLimitOrder,
    placeMarketOrder,
    cancelOrder,
    cancelAllOrders,
} from "../services/trading.js";

const DECIMALS: Record<string, number> = { SUI: 9, DEEP: 6, USDC: 6 };

const suiAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid Sui address");

const createBmSchema = z.object({});

const depositSchema = z.object({
    balanceManagerId: suiAddress,
    coin: z.enum(["SUI", "DEEP", "USDC"]),
    amount: z.number().positive(),
});

const limitOrderSchema = z.object({
    poolKey: z.enum(["DEEP_SUI", "SUI_USDC"]),
    balanceManagerId: suiAddress,
    price: z.number().positive(),
    quantity: z.number().positive(),
    isBid: z.boolean(),
});

const marketOrderSchema = z.object({
    poolKey: z.enum(["DEEP_SUI", "SUI_USDC"]),
    balanceManagerId: suiAddress,
    quantity: z.number().positive(),
    isBid: z.boolean(),
});

const cancelOrderSchema = z.object({
    poolKey: z.enum(["DEEP_SUI", "SUI_USDC"]),
    balanceManagerId: suiAddress,
    orderId: z.string().min(1),
});

const cancelAllSchema = z.object({
    poolKey: z.enum(["DEEP_SUI", "SUI_USDC"]),
    balanceManagerId: suiAddress,
});

const withdrawSchema = z.object({
    balanceManagerId: suiAddress,
    coin: z.enum(["SUI", "DEEP", "USDC"]),
    amount: z.number().positive(),
});

interface PoolInfo {
    poolId: string;
    baseCoinType: string;
    quoteCoinType: string;
}

interface ManifestData {
    deepbookPackageId: string;
    pools: Record<string, PoolInfo>;
    coinTypes: Record<string, string>;
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

        // Build coin type lookup from pool info
        const coinTypes: Record<string, string> = {
            SUI: "0x2::sui::SUI",
        };
        if (pools.DEEP_SUI) {
            coinTypes.DEEP = pools.DEEP_SUI.baseCoinType;
        }
        if (pools.SUI_USDC) {
            coinTypes.USDC = pools.SUI_USDC.quoteCoinType;
        }

        return {
            deepbookPackageId: raw.packages?.deepbook?.packageId,
            pools,
            coinTypes,
        };
    } catch {
        return null;
    }
}

export function tradingRoutes(client: SuiClient, signer: Keypair): Hono {
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

    // GET /trading/balance-manager — find deployer's BM on-chain
    app.get("/balance-manager", async (c) => {
        try {
            const manifest = getManifest();
            const signerAddress = signer.getPublicKey().toSuiAddress();
            const bmType = `${manifest.deepbookPackageId}::balance_manager::BalanceManager`;

            const response = await client.getOwnedObjects({
                owner: signerAddress,
                filter: { StructType: bmType },
                options: { showType: true },
            });

            const bmId =
                response.data.length > 0 && response.data[0].data
                    ? response.data[0].data.objectId
                    : null;

            return c.json({ success: true, balanceManagerId: bmId });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/balances/:balanceManagerId
    app.get("/balances/:balanceManagerId", async (c) => {
        try {
            const balanceManagerId = c.req.param("balanceManagerId");
            const manifest = getManifest();

            const results: Record<string, string> = {};
            for (const [coin, coinType] of Object.entries(manifest.coinTypes)) {
                const balance = await getBalance(
                    client,
                    signer,
                    manifest.deepbookPackageId,
                    balanceManagerId,
                    coinType,
                );
                const decimals = DECIMALS[coin] ?? 6;
                results[coin] = (Number(balance) / 10 ** decimals).toString();
            }

            return c.json({ success: true, balances: results });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/wallet-balances — deployer wallet balances
    app.get("/wallet-balances", async (c) => {
        try {
            const signerAddress = signer.getPublicKey().toSuiAddress();
            const manifest = getManifest();

            const results: Record<string, string> = {};
            for (const [coin, coinType] of Object.entries(manifest.coinTypes)) {
                const coins = await client.getBalance({ owner: signerAddress, coinType });
                const decimals = DECIMALS[coin] ?? 6;
                results[coin] = (Number(coins.totalBalance) / 10 ** decimals).toString();
            }

            return c.json({ success: true, address: signerAddress, balances: results });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/withdraw
    app.post("/withdraw", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = withdrawSchema.parse(body);
            const manifest = getManifest();

            const coinType = manifest.coinTypes[parsed.coin];
            if (!coinType) throw new Error(`Unknown coin: ${parsed.coin}`);

            const decimals = DECIMALS[parsed.coin] ?? 6;
            const amountBase = BigInt(Math.floor(parsed.amount * 10 ** decimals));

            const result = await withdraw(
                client,
                signer,
                manifest.deepbookPackageId,
                parsed.balanceManagerId,
                coinType,
                amountBase,
            );
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/create-balance-manager
    app.post("/create-balance-manager", async (c) => {
        try {
            const manifest = getManifest();
            const result = await createBalanceManager(client, signer, manifest.deepbookPackageId);
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/deposit
    app.post("/deposit", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = depositSchema.parse(body);
            const manifest = getManifest();

            const coinType = manifest.coinTypes[parsed.coin];
            if (!coinType) throw new Error(`Unknown coin: ${parsed.coin}`);

            const decimals = DECIMALS[parsed.coin] ?? 6;
            const amountBase = BigInt(Math.floor(parsed.amount * 10 ** decimals));

            const result = await deposit(
                client,
                signer,
                manifest.deepbookPackageId,
                parsed.balanceManagerId,
                coinType,
                amountBase,
            );
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/limit-order
    app.post("/limit-order", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = limitOrderSchema.parse(body);
            const manifest = getManifest();
            const pool = getPool(manifest, parsed.poolKey);

            // Determine decimals for price and quantity conversion
            const baseDecimals = parsed.poolKey === "DEEP_SUI" ? DECIMALS.DEEP : DECIMALS.SUI;
            const quoteDecimals = parsed.poolKey === "DEEP_SUI" ? DECIMALS.SUI : DECIMALS.USDC;

            // Price is in quote per base units, quantity is in base units
            // DeepBook stores price as (price * 10^quoteDecimals / 10^baseDecimals) scaled
            // But the pool::place_limit_order expects raw price in quote atomic units per base atomic unit
            // scaled by FLOAT_SCALING (1e9)
            const FLOAT_SCALING = 1_000_000_000n;
            const priceRaw =
                (BigInt(Math.floor(parsed.price * 10 ** quoteDecimals)) * FLOAT_SCALING) /
                BigInt(10 ** quoteDecimals);
            const quantityRaw = BigInt(Math.floor(parsed.quantity * 10 ** baseDecimals));

            const result = await placeLimitOrder(client, signer, manifest.deepbookPackageId, {
                poolId: pool.poolId,
                balanceManagerId: parsed.balanceManagerId,
                baseType: pool.baseCoinType,
                quoteType: pool.quoteCoinType,
                price: priceRaw,
                quantity: quantityRaw,
                isBid: parsed.isBid,
            });
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/market-order
    app.post("/market-order", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = marketOrderSchema.parse(body);
            const manifest = getManifest();
            const pool = getPool(manifest, parsed.poolKey);

            const baseDecimals = parsed.poolKey === "DEEP_SUI" ? DECIMALS.DEEP : DECIMALS.SUI;
            const quantityRaw = BigInt(Math.floor(parsed.quantity * 10 ** baseDecimals));

            const result = await placeMarketOrder(client, signer, manifest.deepbookPackageId, {
                poolId: pool.poolId,
                balanceManagerId: parsed.balanceManagerId,
                baseType: pool.baseCoinType,
                quoteType: pool.quoteCoinType,
                quantity: quantityRaw,
                isBid: parsed.isBid,
            });
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/cancel-order
    app.post("/cancel-order", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = cancelOrderSchema.parse(body);
            const manifest = getManifest();
            const pool = getPool(manifest, parsed.poolKey);

            const result = await cancelOrder(client, signer, manifest.deepbookPackageId, {
                poolId: pool.poolId,
                balanceManagerId: parsed.balanceManagerId,
                baseType: pool.baseCoinType,
                quoteType: pool.quoteCoinType,
                orderId: parsed.orderId,
            });
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/cancel-all
    app.post("/cancel-all", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = cancelAllSchema.parse(body);
            const manifest = getManifest();
            const pool = getPool(manifest, parsed.poolKey);

            const result = await cancelAllOrders(client, signer, manifest.deepbookPackageId, {
                poolId: pool.poolId,
                balanceManagerId: parsed.balanceManagerId,
                baseType: pool.baseCoinType,
                quoteType: pool.quoteCoinType,
            });
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    return app;
}

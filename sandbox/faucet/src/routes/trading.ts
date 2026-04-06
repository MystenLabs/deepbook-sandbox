import { Hono } from "hono";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
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
    getOpenOrders,
} from "../services/trading.js";
import {
    getOrCreateClient,
    recreateClient,
    getDeepbookPackageId,
    getCoinTypes,
    getCoinScalar,
    loadFaucetBmId,
    saveFaucetBmId,
    type SandboxClient,
} from "../services/deepbook-client.js";

/* ------------------------------------------------------------------ */
/*  Validation schemas                                                 */
/* ------------------------------------------------------------------ */

const suiAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid Sui address");
const coinKey = z.enum(["SUI", "DEEP", "USDC"]);
const poolKeyEnum = z.enum(["DEEP_SUI", "SUI_USDC"]);

const depositSchema = z.object({
    balanceManagerId: suiAddress,
    coin: coinKey,
    amount: z.number().positive(),
});

const withdrawSchema = z.object({
    balanceManagerId: suiAddress,
    coin: coinKey,
    amount: z.number().positive(),
});

const limitOrderSchema = z.object({
    poolKey: poolKeyEnum,
    balanceManagerId: suiAddress,
    price: z.number().positive(),
    quantity: z.number().positive(),
    isBid: z.boolean(),
});

const marketOrderSchema = z.object({
    poolKey: poolKeyEnum,
    balanceManagerId: suiAddress,
    quantity: z.number().positive(),
    isBid: z.boolean(),
});

const cancelOrderSchema = z.object({
    poolKey: poolKeyEnum,
    balanceManagerId: suiAddress,
    orderId: z.string().min(1),
});

const cancelAllSchema = z.object({
    poolKey: poolKeyEnum,
    balanceManagerId: suiAddress,
});

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export function tradingRoutes(baseClient: SuiGrpcClient, signer: Keypair): Hono {
    const app = new Hono();

    // Lazy SDK client — initialized on first request when the manifest is available
    let dbClient: SandboxClient | null = null;

    async function getClient(): Promise<SandboxClient> {
        if (!dbClient) {
            dbClient = await getOrCreateClient(baseClient, signer);
        }
        return dbClient;
    }

    // GET /trading/balance-manager — return the faucet's dedicated BM
    app.get("/balance-manager", async (c) => {
        try {
            const bmId = loadFaucetBmId();
            return c.json({ success: true, balanceManagerId: bmId });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/balances/:balanceManagerId — BM balances via SDK
    app.get("/balances/:balanceManagerId", async (c) => {
        try {
            const client = await getClient();
            const results: Record<string, string> = {};

            for (const coin of ["SUI", "DEEP", "USDC"]) {
                const balance = await getBalance(client, signer, coin);
                results[coin] = String(balance);
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
            const results: Record<string, string> = {};

            // Try to get coin types from the manifest (may not be ready yet)
            let coinTypes: Record<string, string>;
            try {
                await getClient(); // ensure manifest is loaded
                coinTypes = getCoinTypes();
            } catch {
                // Manifest not ready — just return SUI balance
                coinTypes = { SUI: "0x2::sui::SUI" };
            }

            for (const [coin, coinType] of Object.entries(coinTypes)) {
                const resp = await baseClient.getBalance({ owner: signerAddress, coinType });
                const scalar = getCoinScalar(coin);
                results[coin] = String(Number(resp.balance.balance) / scalar);
            }

            return c.json({ success: true, address: signerAddress, balances: results });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/pool-params/:poolKey — tick size, lot size, min size
    app.get("/pool-params/:poolKey", async (c) => {
        try {
            const pk = poolKeyEnum.parse(c.req.param("poolKey"));
            const client = await getClient();
            const params = await client.deepbook.poolBookParams(pk);
            return c.json({ success: true, ...params });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/mid-price/:poolKey — current mid price via SDK
    app.get("/mid-price/:poolKey", async (c) => {
        try {
            const pk = poolKeyEnum.parse(c.req.param("poolKey"));
            const client = await getClient();
            const midPrice = await client.deepbook.midPrice(pk);
            return c.json({ success: true, midPrice });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/orders/:poolKey — open order details
    app.get("/orders/:poolKey", async (c) => {
        try {
            const pk = poolKeyEnum.parse(c.req.param("poolKey"));
            const client = await getClient();
            const orders = await getOpenOrders(client, signer, pk);
            return c.json({ success: true, orders });
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
            const client = await getClient();
            const result = await createBalanceManager(client, signer);

            // Persist BM ID so it survives container restarts
            saveFaucetBmId(result.balanceManagerId);

            // Re-create the SDK client with the new BM registered
            dbClient = recreateClient(baseClient, signer, result.balanceManagerId);

            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/deposit — amount in human units (SDK handles decimals)
    app.post("/deposit", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = depositSchema.parse(body);
            const client = await getClient();

            const result = await deposit(client, signer, parsed.coin, parsed.amount);
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/withdraw — amount in human units
    app.post("/withdraw", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = withdrawSchema.parse(body);
            const client = await getClient();

            const result = await withdraw(client, signer, parsed.coin, parsed.amount);
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // POST /trading/limit-order — price & quantity in human units
    app.post("/limit-order", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = limitOrderSchema.parse(body);
            const client = await getClient();

            const result = await placeLimitOrder(client, signer, {
                poolKey: parsed.poolKey,
                price: parsed.price,
                quantity: parsed.quantity,
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

    // POST /trading/market-order — quantity in human units
    app.post("/market-order", async (c) => {
        try {
            const body = await c.req.json();
            const parsed = marketOrderSchema.parse(body);
            const client = await getClient();

            const result = await placeMarketOrder(client, signer, {
                poolKey: parsed.poolKey,
                quantity: parsed.quantity,
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
            const client = await getClient();

            const result = await cancelOrder(client, signer, parsed.poolKey, parsed.orderId);
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
            const client = await getClient();

            const result = await cancelAllOrders(client, signer, parsed.poolKey);
            return c.json({ success: true, ...result });
        } catch (err) {
            return c.json(
                { success: false, error: err instanceof Error ? err.message : "Failed" },
                500,
            );
        }
    });

    // GET /trading/pool-details/:poolKey — mid price, book params, order book depth (via SDK)
    app.get("/pool-details/:poolKey", async (c) => {
        try {
            const pk = poolKeyEnum.parse(c.req.param("poolKey"));
            const client = await getClient();

            const [midPrice, bookParams, depth] = await Promise.all([
                client.deepbook.midPrice(pk),
                client.deepbook.poolBookParams(pk),
                client.deepbook.getLevel2TicksFromMid(pk, 10),
            ]);

            return c.json({
                success: true,
                midPrice: String(midPrice),
                tickSize: String(bookParams.tickSize),
                lotSize: String(bookParams.lotSize),
                minSize: String(bookParams.minSize),
                bids: depth.bid_prices.map((price, i) => ({
                    price: String(price),
                    quantity: String(depth.bid_quantities[i]),
                })),
                asks: depth.ask_prices.map((price, i) => ({
                    price: String(price),
                    quantity: String(depth.ask_quantities[i]),
                })),
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

import { Hono } from "hono";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";
import type { FaucetConfig } from "../config.js";
import { requestSui } from "../services/sui-faucet.js";
import { requestCoin } from "../services/coin-faucet.js";

const DEFAULT_AMOUNT = 1000;

const bodySchema = z.object({
    address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "Invalid Sui address (expected 0x + 64 hex chars)"),
    token: z.enum(["SUI", "DEEP", "USDC"]),
    amount: z.number().positive().int().optional(),
});

export function faucetRoutes(config: FaucetConfig, client: SuiGrpcClient, signer: Keypair): Hono {
    const app = new Hono();

    const coins = {
        DEEP: { type: config.deepType, decimals: 6, max: config.maxDeepPerRequest },
        USDC: { type: config.usdcType, decimals: 6, max: config.maxUsdcPerRequest },
    } as const;

    app.post("/faucet", async (c) => {
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ success: false, error: "Request body must be valid JSON" }, 400);
        }

        const parsed = bodySchema.safeParse(body);
        if (!parsed.success) {
            return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
        }

        const { address, token, amount } = parsed.data;

        if (token === "SUI") {
            const result = await requestSui(config.suiFaucetUrl, address);
            return c.json(result, result.success ? 200 : 502);
        }

        const { type, decimals, max } = coins[token];
        const whole = amount ?? DEFAULT_AMOUNT;
        if (whole > max) {
            return c.json(
                {
                    success: false,
                    error: `Amount exceeds maximum of ${max} ${token} per request`,
                },
                400,
            );
        }

        const baseUnits = whole * 10 ** decimals;
        const result = await requestCoin(client, signer, type, address, baseUnits);
        return c.json(result, result.success ? 200 : 500);
    });

    return app;
}

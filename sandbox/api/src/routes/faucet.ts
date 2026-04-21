import { Hono } from "hono";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { z } from "zod";
import type { FaucetConfig } from "../config.js";
import { requestSui } from "../services/sui-faucet.js";
import { requestDeep } from "../services/deep-faucet.js";
import { requestUsdc } from "../services/usdc-faucet.js";

const DEEP_DECIMALS = 6;
const DEFAULT_DEEP_AMOUNT = 1000;
const USDC_DECIMALS = 6;
const DEFAULT_USDC_AMOUNT = 1000;

const bodySchema = z.object({
    address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "Invalid Sui address (expected 0x + 64 hex chars)"),
    token: z.enum(["SUI", "DEEP", "USDC"]),
    amount: z.number().positive().int().optional(),
});

export function faucetRoutes(config: FaucetConfig, client: SuiGrpcClient, signer: Keypair): Hono {
    const app = new Hono();

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

        if (token === "DEEP") {
            const deepAmount = amount ?? DEFAULT_DEEP_AMOUNT;
            if (deepAmount > config.maxDeepPerRequest) {
                return c.json(
                    {
                        success: false,
                        error: `Amount exceeds maximum of ${config.maxDeepPerRequest} DEEP per request`,
                    },
                    400,
                );
            }

            const baseUnits = deepAmount * 10 ** DEEP_DECIMALS;
            const result = await requestDeep(client, signer, config.deepType, address, baseUnits);
            return c.json(result, result.success ? 200 : 500);
        }

        const usdcAmount = amount ?? DEFAULT_USDC_AMOUNT;
        if (usdcAmount > config.maxUsdcPerRequest) {
            return c.json(
                {
                    success: false,
                    error: `Amount exceeds maximum of ${config.maxUsdcPerRequest} USDC per request`,
                },
                400,
            );
        }

        const baseUnits = usdcAmount * 10 ** USDC_DECIMALS;
        const result = await requestUsdc(client, signer, config.usdcType, address, baseUnits);
        return c.json(result, result.success ? 200 : 500);
    });

    return app;
}

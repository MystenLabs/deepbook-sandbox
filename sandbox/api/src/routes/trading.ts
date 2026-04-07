import { Hono } from "hono";

export function tradingRoutes(balanceManagerId?: string): Hono {
    const app = new Hono();

    // GET /trading/balance-manager — return the deployer's BM (set by deploy-all)
    app.get("/balance-manager", async (c) => {
        return c.json({ success: true, balanceManagerId: balanceManagerId ?? null });
    });

    return app;
}

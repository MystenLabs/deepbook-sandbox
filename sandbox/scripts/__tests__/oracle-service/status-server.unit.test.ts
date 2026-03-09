import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "http";
import {
    createStatusServer,
    createInitialStatus,
    updateStatus,
    type OracleStatus,
} from "../../oracle-service/status-server";
import { makeSuiPriceData, makeDeepPriceData, makeUsdcPriceData } from "./fixtures";

/** Start the status server on an ephemeral port, return the base URL. */
function startServer(status: OracleStatus): Promise<{ server: Server; baseUrl: string }> {
    return new Promise((resolve) => {
        const server = createStatusServer(status);
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

describe("status server", () => {
    let server: Server;
    let baseUrl: string;
    let status: OracleStatus;

    beforeAll(async () => {
        status = createInitialStatus();
        ({ server, baseUrl } = await startServer(status));
    });

    afterAll(
        () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    );

    beforeEach(() => {
        // Reset status between tests
        Object.assign(status, createInitialStatus());
    });

    describe("routing", () => {
        it("GET / returns 200 with JSON status", async () => {
            const res = await fetch(`${baseUrl}/`);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toBe("application/json");

            const body = await res.json();
            expect(body.status).toBe("ok");
        });

        it("GET /status returns 200 with same JSON", async () => {
            const res = await fetch(`${baseUrl}/status`);
            expect(res.status).toBe(200);

            const body = await res.json();
            expect(body.status).toBe("ok");
        });

        it("GET /unknown returns 404", async () => {
            const res = await fetch(`${baseUrl}/unknown`);
            expect(res.status).toBe(404);

            const body = await res.json();
            expect(body.error).toBe("Not Found");
        });

        it("POST / returns 405 with Allow header", async () => {
            const res = await fetch(`${baseUrl}/`, { method: "POST" });
            expect(res.status).toBe(405);
            expect(res.headers.get("allow")).toBe("GET");

            const body = await res.json();
            expect(body.error).toBe("Method Not Allowed");
        });

        it("PUT / returns 405", async () => {
            const res = await fetch(`${baseUrl}/`, { method: "PUT" });
            expect(res.status).toBe(405);
        });

        it("strips query parameters from path matching", async () => {
            const res = await fetch(`${baseUrl}/?foo=bar`);
            expect(res.status).toBe(200);
        });
    });

    describe("response body", () => {
        it("returns initial status with null prices", async () => {
            const res = await fetch(`${baseUrl}/`);
            const body = await res.json();

            expect(body).toEqual({
                status: "ok",
                updates: 0,
                errors: 0,
                lastUpdate: null,
                prices: {
                    sui: null,
                    deep: null,
                    usdc: null,
                },
            });
        });

        it("reflects updated status after price update", async () => {
            status.updateCount = 5;
            status.errorCount = 1;
            status.lastUpdateTime = "2024-01-01T00:00:00.000Z";
            status.lastSuiPrice = "3.45000000";
            status.lastDeepPrice = "0.02150000";
            status.lastUsdcPrice = "1.00000000";

            const res = await fetch(`${baseUrl}/`);
            const body = await res.json();

            expect(body.updates).toBe(5);
            expect(body.errors).toBe(1);
            expect(body.lastUpdate).toBe("2024-01-01T00:00:00.000Z");
            expect(body.prices.sui).toBe("$3.45000000");
            expect(body.prices.deep).toBe("$0.02150000");
            expect(body.prices.usdc).toBe("$1.00000000");
        });

        it("prefixes prices with $ sign", async () => {
            status.lastSuiPrice = "100.00000000";
            status.lastDeepPrice = "0.00000001";
            status.lastUsdcPrice = "1.00000000";

            const res = await fetch(`${baseUrl}/`);
            const body = await res.json();

            expect(body.prices.sui).toBe("$100.00000000");
            expect(body.prices.deep).toBe("$0.00000001");
            expect(body.prices.usdc).toBe("$1.00000000");
        });
    });

    describe("high-frequency queries", () => {
        it("handles 50 rapid sequential queries without errors", async () => {
            const responses = [];
            for (let i = 0; i < 50; i++) {
                responses.push(fetch(`${baseUrl}/`));
            }
            const results = await Promise.all(responses);

            for (const res of results) {
                expect(res.status).toBe(200);
            }
        });

        it("returns consistent data across rapid queries", async () => {
            status.updateCount = 42;
            status.lastSuiPrice = "3.45000000";
            status.lastDeepPrice = "0.02150000";
            status.lastUsdcPrice = "1.00000000";

            const responses = await Promise.all(
                Array.from({ length: 20 }, () => fetch(`${baseUrl}/`).then((r) => r.json())),
            );

            for (const body of responses) {
                expect(body.updates).toBe(42);
                expect(body.prices.sui).toBe("$3.45000000");
            }
        });
    });
});

describe("updateStatus", () => {
    it("mutates the status object with formatted prices", () => {
        const status = createInitialStatus();
        const suiData = makeSuiPriceData();
        const deepData = makeDeepPriceData();
        const usdcData = makeUsdcPriceData();

        updateStatus(status, suiData, deepData, usdcData);

        expect(status.lastSuiPrice).toBe("3.45000000");
        expect(status.lastDeepPrice).toBe("0.02150000");
        expect(status.lastUsdcPrice).toBe("1.00000000");
        expect(status.lastUpdateTime).not.toBeNull();
    });

    it("sets lastUpdateTime to ISO string", () => {
        const status = createInitialStatus();
        const before = new Date().toISOString();

        updateStatus(status, makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData());

        const after = new Date().toISOString();
        expect(status.lastUpdateTime).not.toBeNull();
        expect(status.lastUpdateTime! >= before).toBe(true);
        expect(status.lastUpdateTime! <= after).toBe(true);
    });

    it("overwrites previous values on subsequent calls", () => {
        const status = createInitialStatus();

        // First update: SUI = $3.45
        updateStatus(status, makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData());
        expect(status.lastSuiPrice).toBe("3.45000000");

        // Second update: SUI = $5.00 (different price)
        const newSui = makeSuiPriceData({
            price: { price: "500000000", conf: "200000", expo: -8, publish_time: 1700000100 },
        });
        updateStatus(status, newSui, makeDeepPriceData(), makeUsdcPriceData());

        expect(status.lastSuiPrice).toBe("5.00000000");
        expect(status.lastUpdateTime).not.toBeNull();
    });
});

describe("createInitialStatus", () => {
    it("returns zeroed status object", () => {
        const status = createInitialStatus();
        expect(status.updateCount).toBe(0);
        expect(status.errorCount).toBe(0);
        expect(status.lastUpdateTime).toBeNull();
        expect(status.lastSuiPrice).toBeNull();
        expect(status.lastDeepPrice).toBeNull();
        expect(status.lastUsdcPrice).toBeNull();
    });

    it("returns a new object each call (no shared state)", () => {
        const a = createInitialStatus();
        const b = createInitialStatus();
        a.updateCount = 99;
        expect(b.updateCount).toBe(0);
    });
});

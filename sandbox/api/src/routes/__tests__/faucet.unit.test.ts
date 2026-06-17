import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock the service layer so the route's status mapping is what's under test.
// `vi.hoisted` lets the hoisted vi.mock factory reference the mock fn safely.
const { requestCoin } = vi.hoisted(() => ({ requestCoin: vi.fn() }));
vi.mock("../../services/coin-faucet.js", () => ({ requestCoin }));
vi.mock("../../services/sui-faucet.js", () => ({ requestSui: vi.fn() }));

import { faucetRoutes } from "../faucet.js";
import type { FaucetConfig } from "../../config.js";

const config = {
    deepType: "0x2::deep::DEEP",
    usdcType: "0x2::usdc::USDC",
    suiFaucetUrl: "http://localhost:9123",
    maxDeepPerRequest: 10_000,
    maxUsdcPerRequest: 10_000,
} as unknown as FaucetConfig;

// Only the mocked requestCoin return drives the assertions, so the client/signer
// can be inert stubs.
const app = faucetRoutes(config, {} as never, {} as never);
const ADDR = "0x" + "a".repeat(64);

function post(body: unknown) {
    return app.request("/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

beforeEach(() => requestCoin.mockReset());

describe("POST /faucet status mapping", () => {
    test("success -> 200", async () => {
        requestCoin.mockResolvedValue({ success: true, digest: "0xdig" });
        const res = await post({ address: ADDR, token: "DEEP" });
        expect(res.status).toBe(200);
    });

    test("exhausted -> 503 with redeploy hint", async () => {
        requestCoin.mockResolvedValue({ success: false, kind: "exhausted", error: "No coins found" });
        const res = await post({ address: ADDR, token: "DEEP" });
        expect(res.status).toBe(503);
        expect((await res.json()).error).toContain("pnpm deploy-all");
    });

    test("busy -> 503", async () => {
        requestCoin.mockResolvedValue({ success: false, kind: "busy", error: "in progress" });
        const res = await post({ address: ADDR, token: "USDC" });
        expect(res.status).toBe(503);
    });

    test("tx_failed -> 500", async () => {
        requestCoin.mockResolvedValue({ success: false, kind: "tx_failed", error: "MoveAbort" });
        const res = await post({ address: ADDR, token: "DEEP" });
        expect(res.status).toBe(500);
    });
});

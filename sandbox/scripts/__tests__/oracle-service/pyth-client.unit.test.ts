import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PythClient } from "../../oracle-service/pyth-client";
import { makeTestConfig, makePythPriceUpdate } from "./fixtures";
import type { OracleConfig } from "../../oracle-service/types";

describe("PythClient", () => {
    let config: OracleConfig;
    let client: PythClient;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        config = makeTestConfig();
        client = new PythClient(config);

        // Mock global fetch
        fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("fetchPriceUpdates", () => {
        it("constructs the correct Pyth API URL", async () => {
            const mockResponse = makePythPriceUpdate();
            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            await client.fetchPriceUpdates();

            expect(fetchSpy).toHaveBeenCalledOnce();
            const url = new URL(fetchSpy.mock.calls[0][0]);

            expect(url.origin).toBe("https://benchmarks.pyth.network");
            expect(url.pathname).toMatch(/^\/v1\/updates\/price\/\d+$/);
            expect(url.searchParams.getAll("ids")).toHaveLength(3);
            expect(url.searchParams.get("encoding")).toBe("hex");
            expect(url.searchParams.get("parsed")).toBe("true");
        });

        it("includes all three price feed IDs as query params", async () => {
            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(makePythPriceUpdate()),
            });

            await client.fetchPriceUpdates();

            const url = new URL(fetchSpy.mock.calls[0][0]);
            const ids = url.searchParams.getAll("ids");
            expect(ids).toContain(config.priceFeeds.sui);
            expect(ids).toContain(config.priceFeeds.deep);
            expect(ids).toContain(config.priceFeeds.usdc);
        });

        it("calculates timestamp from historicalDataHours ago", async () => {
            const nowSec = Math.floor(Date.now() / 1000);
            const expectedTimestamp = nowSec - config.historicalDataHours * 3600;

            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(makePythPriceUpdate()),
            });

            await client.fetchPriceUpdates();

            const url = new URL(fetchSpy.mock.calls[0][0]);
            const pathTimestamp = Number(url.pathname.split("/").pop());

            // Allow 2-second tolerance for test execution time
            expect(Math.abs(pathTimestamp - expectedTimestamp)).toBeLessThan(2);
        });

        it("returns parsed price data on success", async () => {
            const mockResponse = makePythPriceUpdate();
            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            const result = await client.fetchPriceUpdates();

            expect(result.parsed).toHaveLength(3);
            expect(result.binary.encoding).toBe("hex");
        });

        it("throws on HTTP error response", async () => {
            fetchSpy.mockResolvedValue({
                ok: false,
                status: 500,
                statusText: "Internal Server Error",
            });

            await expect(client.fetchPriceUpdates()).rejects.toThrow(
                "Pyth API request failed: 500 Internal Server Error",
            );
        });

        it("throws on empty parsed data", async () => {
            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ binary: { encoding: "hex", data: [] }, parsed: [] }),
            });

            await expect(client.fetchPriceUpdates()).rejects.toThrow(
                "No price data returned from Pyth API",
            );
        });

        it("throws on null parsed data", async () => {
            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ binary: { encoding: "hex", data: [] }, parsed: null }),
            });

            await expect(client.fetchPriceUpdates()).rejects.toThrow(
                "No price data returned from Pyth API",
            );
        });

        it("throws on network error (fetch rejects)", async () => {
            fetchSpy.mockRejectedValue(new Error("Network unreachable"));

            await expect(client.fetchPriceUpdates()).rejects.toThrow("Network unreachable");
        });

        it("uses custom pythApiUrl from config", async () => {
            const customConfig = makeTestConfig({ pythApiUrl: "https://custom-pyth.example.com" });
            const customClient = new PythClient(customConfig);

            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(makePythPriceUpdate()),
            });

            await customClient.fetchPriceUpdates();

            const url = new URL(fetchSpy.mock.calls[0][0]);
            expect(url.origin).toBe("https://custom-pyth.example.com");
        });

        it("uses different historicalDataHours", async () => {
            const customConfig = makeTestConfig({ historicalDataHours: 48 });
            const customClient = new PythClient(customConfig);
            const nowSec = Math.floor(Date.now() / 1000);
            const expectedTimestamp = nowSec - 48 * 3600;

            fetchSpy.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(makePythPriceUpdate()),
            });

            await customClient.fetchPriceUpdates();

            const url = new URL(fetchSpy.mock.calls[0][0]);
            const pathTimestamp = Number(url.pathname.split("/").pop());
            expect(Math.abs(pathTimestamp - expectedTimestamp)).toBeLessThan(2);
        });
    });
});

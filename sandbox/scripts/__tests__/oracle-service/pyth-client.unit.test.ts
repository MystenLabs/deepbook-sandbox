import { describe, test, expect, vi, afterEach } from "vitest";
import { PythClient } from "../../oracle-service/pyth-client";
import { makeTestConfig, makePythPriceUpdate } from "./fixtures";

vi.mock("../../utils/logger", () => ({
    default: {
        loop: vi.fn(),
        loopSuccess: vi.fn(),
        loopError: vi.fn(),
    },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", mockFetch);
});

describe("PythClient", () => {
    describe("URL construction", () => {
        test("builds correct URL with feed IDs and query params", async () => {
            const config = makeTestConfig();
            const client = new PythClient(config);
            const mockResponse = makePythPriceUpdate();

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            await client.fetchPriceUpdates();

            expect(mockFetch).toHaveBeenCalledOnce();
            const url = mockFetch.mock.calls[0][0] as string;

            expect(url).toContain("https://benchmarks.pyth.network/v1/updates/price/");
            expect(url).toContain(`ids=${config.priceFeeds.sui}`);
            expect(url).toContain(`ids=${config.priceFeeds.deep}`);
            expect(url).toContain(`ids=${config.priceFeeds.usdc}`);
            expect(url).toContain("encoding=hex");
            expect(url).toContain("parsed=true");
        });

        test("uses timestamp approximately 24 hours ago", async () => {
            const config = makeTestConfig({ historicalDataHours: 24 });
            const client = new PythClient(config);

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makePythPriceUpdate()),
            });

            await client.fetchPriceUpdates();

            const url = mockFetch.mock.calls[0][0] as string;
            const timestampMatch = url.match(/\/v1\/updates\/price\/(\d+)\?/);
            expect(timestampMatch).not.toBeNull();

            const timestamp = Number.parseInt(timestampMatch![1]);
            const expected = Math.floor(Date.now() / 1000) - 24 * 3600;
            expect(Math.abs(timestamp - expected)).toBeLessThan(5);
        });
    });

    describe("response parsing", () => {
        test("returns parsed price data on success", async () => {
            const client = new PythClient(makeTestConfig());
            const mockResponse = makePythPriceUpdate();

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            const result = await client.fetchPriceUpdates();

            expect(result.parsed).toHaveLength(3);
            expect(result.parsed[0].price.price).toBe("345000000");
        });
    });

    describe("error handling", () => {
        test("throws on non-ok HTTP response", async () => {
            const client = new PythClient(makeTestConfig());

            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 429,
                statusText: "Too Many Requests",
            });

            await expect(client.fetchPriceUpdates()).rejects.toThrow("429");
        });

        test("throws on empty price data", async () => {
            const client = new PythClient(makeTestConfig());

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () =>
                    Promise.resolve({
                        binary: { encoding: "hex", data: [] },
                        parsed: [],
                    }),
            });

            await expect(client.fetchPriceUpdates()).rejects.toThrow("No price data");
        });

        test("propagates network errors", async () => {
            const client = new PythClient(makeTestConfig());

            mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

            await expect(client.fetchPriceUpdates()).rejects.toThrow("fetch failed");
        });
    });
});

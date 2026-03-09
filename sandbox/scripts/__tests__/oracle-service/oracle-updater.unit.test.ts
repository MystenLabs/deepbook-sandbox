import { describe, it, expect, vi, beforeEach } from "vitest";
import { OracleUpdater } from "../../oracle-service/oracle-updater";
import { makeSuiPriceData, makeDeepPriceData, makeUsdcPriceData, stripHexPrefix } from "./fixtures";
import { SUI_PRICE_FEED_ID } from "../../oracle-service/constants";
import type { ParsedPriceData } from "../../oracle-service/types";

/**
 * Create a mock SuiClient that captures signAndExecuteTransaction calls.
 */
function createMockClient(result?: { effects?: { status: { status: string; error?: string } }; digest?: string }) {
    return {
        signAndExecuteTransaction: vi.fn().mockResolvedValue(
            result ?? {
                effects: { status: { status: "success" } },
                digest: "mock-digest-abc123",
            },
        ),
    } as any;
}

function createMockSigner() {
    return {} as any;
}

const FAKE_PYTH_PACKAGE = "0x" + "a".repeat(64);
const FAKE_PRICE_INFO_IDS = {
    sui: "0x" + "1".repeat(64),
    deep: "0x" + "2".repeat(64),
    usdc: "0x" + "3".repeat(64),
};

describe("OracleUpdater", () => {
    let mockClient: ReturnType<typeof createMockClient>;
    let updater: OracleUpdater;

    beforeEach(() => {
        mockClient = createMockClient();
        updater = new OracleUpdater(mockClient, createMockSigner(), FAKE_PYTH_PACKAGE);
    });

    describe("updatePriceFeeds", () => {
        it("succeeds with valid SUI, DEEP, and USDC price data", async () => {
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).resolves.not.toThrow();

            expect(mockClient.signAndExecuteTransaction).toHaveBeenCalledOnce();
        });

        it("passes transaction and signer to client", async () => {
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS);

            const call = mockClient.signAndExecuteTransaction.mock.calls[0][0];
            expect(call.transaction).toBeDefined();
            expect(call.signer).toBeDefined();
            expect(call.options.showEffects).toBe(true);
        });

        it("throws when SUI price data is missing", async () => {
            const priceData = [makeDeepPriceData(), makeUsdcPriceData()];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).rejects.toThrow("Missing price data");
        });

        it("throws when DEEP price data is missing", async () => {
            const priceData = [makeSuiPriceData(), makeUsdcPriceData()];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).rejects.toThrow("Missing price data");
        });

        it("throws when USDC price data is missing", async () => {
            const priceData = [makeSuiPriceData(), makeDeepPriceData()];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).rejects.toThrow("Missing price data");
        });

        it("throws when price array is empty", async () => {
            await expect(
                updater.updatePriceFeeds([], FAKE_PRICE_INFO_IDS),
            ).rejects.toThrow("Missing price data");
        });

        it("throws on transaction failure", async () => {
            const failClient = createMockClient({
                effects: { status: { status: "failure", error: "InsufficientGas" } },
                digest: "fail-digest",
            });
            const failUpdater = new OracleUpdater(failClient, createMockSigner(), FAKE_PYTH_PACKAGE);
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await expect(
                failUpdater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).rejects.toThrow("Transaction failed: InsufficientGas");
        });

        it("throws when signAndExecuteTransaction rejects", async () => {
            mockClient.signAndExecuteTransaction.mockRejectedValue(
                new Error("RPC connection refused"),
            );
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).rejects.toThrow("RPC connection refused");
        });

        it("handles price data with extra feeds (ignores unknown)", async () => {
            const extraFeed: ParsedPriceData = {
                id: "ff".repeat(32),
                price: { price: "999", conf: "1", expo: -2, publish_time: 1700000000 },
                ema_price: { price: "999", conf: "1", expo: -2, publish_time: 1700000000 },
            };
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData(), extraFeed];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).resolves.not.toThrow();
        });

        it("handles negative price values", async () => {
            const negativeSui = makeSuiPriceData({
                price: { price: "-100000000", conf: "50000", expo: -8, publish_time: 1700000000 },
            });
            const priceData = [negativeSui, makeDeepPriceData(), makeUsdcPriceData()];

            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).resolves.not.toThrow();
        });

        it("matches feed IDs without 0x prefix (as Pyth returns)", async () => {
            // Pyth API returns IDs without 0x prefix; constants have 0x prefix.
            // The updater uses .slice(2) to strip the prefix when comparing.
            const suiData = makeSuiPriceData();
            expect(suiData.id).toBe(stripHexPrefix(SUI_PRICE_FEED_ID));

            const priceData = [suiData, makeDeepPriceData(), makeUsdcPriceData()];
            await expect(
                updater.updatePriceFeeds(priceData, FAKE_PRICE_INFO_IDS),
            ).resolves.not.toThrow();
        });
    });
});

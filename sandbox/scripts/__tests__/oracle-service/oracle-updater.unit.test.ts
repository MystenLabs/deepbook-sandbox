import { describe, test, expect, vi } from "vitest";
import { OracleUpdater } from "../../oracle-service/oracle-updater";
import { makeSuiPriceData, makeDeepPriceData, makeUsdcPriceData } from "./fixtures";

vi.mock("../../utils/logger", () => ({
    default: {
        loop: vi.fn(),
        loopSuccess: vi.fn(),
        loopError: vi.fn(),
        loopDetail: vi.fn(),
    },
}));

const priceInfoObjectIds = {
    sui: "0x" + "a".repeat(64),
    deep: "0x" + "b".repeat(64),
    usdc: "0x" + "c".repeat(64),
};

function createMockClient() {
    return {
        signAndExecuteTransaction: vi.fn(),
    };
}

function createMockSigner() {
    return {
        getPublicKey: vi.fn(),
        signTransaction: vi.fn(),
        signPersonalMessage: vi.fn(),
        sign: vi.fn(),
        getKeyScheme: vi.fn().mockReturnValue("ED25519"),
        toSuiAddress: vi.fn().mockReturnValue("0x" + "0".repeat(64)),
    };
}

describe("OracleUpdater", () => {
    describe("missing price data", () => {
        test("throws when SUI data is missing", async () => {
            const client = createMockClient();
            const updater = new OracleUpdater(client as any, createMockSigner() as any, "0xpyth");

            const priceData = [makeDeepPriceData(), makeUsdcPriceData()];

            await expect(updater.updatePriceFeeds(priceData, priceInfoObjectIds)).rejects.toThrow(
                "Missing price data",
            );
        });

        test("throws when DEEP data is missing", async () => {
            const client = createMockClient();
            const updater = new OracleUpdater(client as any, createMockSigner() as any, "0xpyth");

            const priceData = [makeSuiPriceData(), makeUsdcPriceData()];

            await expect(updater.updatePriceFeeds(priceData, priceInfoObjectIds)).rejects.toThrow(
                "Missing price data",
            );
        });

        test("throws when USDC data is missing", async () => {
            const client = createMockClient();
            const updater = new OracleUpdater(client as any, createMockSigner() as any, "0xpyth");

            const priceData = [makeSuiPriceData(), makeDeepPriceData()];

            await expect(updater.updatePriceFeeds(priceData, priceInfoObjectIds)).rejects.toThrow(
                "Missing price data",
            );
        });
    });

    describe("successful transaction", () => {
        test("calls signAndExecuteTransaction with include effects", async () => {
            const client = createMockClient();
            client.signAndExecuteTransaction.mockResolvedValueOnce({
                $kind: "Transaction",
                Transaction: { digest: "abc123", status: { success: true, error: null } },
            });

            const updater = new OracleUpdater(client as any, createMockSigner() as any, "0xpyth");
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await updater.updatePriceFeeds(priceData, priceInfoObjectIds);

            expect(client.signAndExecuteTransaction).toHaveBeenCalledOnce();
            const callArgs = client.signAndExecuteTransaction.mock.calls[0][0];
            expect(callArgs.include.effects).toBe(true);
        });
    });

    describe("failure handling", () => {
        test("throws on failed transaction status", async () => {
            const client = createMockClient();
            client.signAndExecuteTransaction.mockResolvedValueOnce({
                $kind: "FailedTransaction",
                FailedTransaction: {
                    digest: "abc123",
                    status: { success: false, error: "InsufficientGas" },
                },
            });

            const updater = new OracleUpdater(client as any, createMockSigner() as any, "0xpyth");
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await expect(updater.updatePriceFeeds(priceData, priceInfoObjectIds)).rejects.toThrow(
                "Transaction failed",
            );
        });

        test("propagates execution errors", async () => {
            const client = createMockClient();
            client.signAndExecuteTransaction.mockRejectedValueOnce(new Error("RPC timeout"));

            const updater = new OracleUpdater(client as any, createMockSigner() as any, "0xpyth");
            const priceData = [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()];

            await expect(updater.updatePriceFeeds(priceData, priceInfoObjectIds)).rejects.toThrow(
                "RPC timeout",
            );
        });
    });
});

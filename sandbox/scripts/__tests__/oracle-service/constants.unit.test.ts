import { describe, test, expect } from "vitest";
import {
    SUI_PRICE_FEED_ID,
    DEEP_PRICE_FEED_ID,
    USDC_PRICE_FEED_ID,
} from "../../oracle-service/constants";

describe("price feed ID constants", () => {
    const feedIds = [
        { name: "SUI_PRICE_FEED_ID", value: SUI_PRICE_FEED_ID },
        { name: "DEEP_PRICE_FEED_ID", value: DEEP_PRICE_FEED_ID },
        { name: "USDC_PRICE_FEED_ID", value: USDC_PRICE_FEED_ID },
    ];

    test.each(feedIds)("$name starts with 0x", ({ value }) => {
        expect(value.startsWith("0x")).toBe(true);
    });

    test.each(feedIds)("$name is 66 characters (0x + 64 hex)", ({ value }) => {
        expect(value).toHaveLength(66);
    });

    test.each(feedIds)("$name matches hex pattern", ({ value }) => {
        expect(value).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    test("SUI feed ID matches known value", () => {
        expect(SUI_PRICE_FEED_ID).toBe(
            "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
        );
    });

    test("DEEP feed ID matches known value", () => {
        expect(DEEP_PRICE_FEED_ID).toBe(
            "0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff",
        );
    });

    test("USDC feed ID matches known value", () => {
        expect(USDC_PRICE_FEED_ID).toBe(
            "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
        );
    });

    test("all three feed IDs are distinct", () => {
        const ids = new Set([SUI_PRICE_FEED_ID, DEEP_PRICE_FEED_ID, USDC_PRICE_FEED_ID]);
        expect(ids.size).toBe(3);
    });
});

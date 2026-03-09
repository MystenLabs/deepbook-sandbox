import { describe, it, expect } from "vitest";
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

    it.each(feedIds)("$name is 0x-prefixed 32-byte hex (66 chars)", ({ value }) => {
        expect(value).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it("all three feed IDs are distinct", () => {
        const unique = new Set(feedIds.map((f) => f.value));
        expect(unique.size).toBe(3);
    });

    it("SUI feed ID matches known Pyth identifier", () => {
        expect(SUI_PRICE_FEED_ID).toBe(
            "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
        );
    });

    it("DEEP feed ID matches known Pyth identifier", () => {
        expect(DEEP_PRICE_FEED_ID).toBe(
            "0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff",
        );
    });

    it("USDC feed ID matches known Pyth identifier", () => {
        expect(USDC_PRICE_FEED_ID).toBe(
            "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
        );
    });
});

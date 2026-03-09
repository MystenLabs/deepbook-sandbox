import type { ParsedPriceData, PythPriceUpdate, OracleConfig } from "../../oracle-service/types";
import {
    SUI_PRICE_FEED_ID,
    DEEP_PRICE_FEED_ID,
    USDC_PRICE_FEED_ID,
} from "../../oracle-service/constants";

/**
 * Strip the "0x" prefix from a feed ID (Pyth response IDs omit it).
 */
export function stripHexPrefix(id: string): string {
    return id.startsWith("0x") ? id.slice(2) : id;
}

/** Build a single ParsedPriceData entry with sensible defaults. */
export function makePriceData(overrides: Partial<ParsedPriceData> & { id: string }): ParsedPriceData {
    const now = Math.floor(Date.now() / 1000);
    return {
        id: overrides.id,
        price: {
            price: "345000000",
            conf: "150000",
            expo: -8,
            publish_time: now,
            ...overrides.price,
        },
        ema_price: {
            price: "340000000",
            conf: "140000",
            expo: -8,
            publish_time: now,
            ...overrides.ema_price,
        },
        metadata: overrides.metadata,
    };
}

/** A realistic SUI price data entry ($3.45). */
export function makeSuiPriceData(overrides?: Partial<ParsedPriceData>): ParsedPriceData {
    return makePriceData({
        id: stripHexPrefix(SUI_PRICE_FEED_ID),
        price: { price: "345000000", conf: "150000", expo: -8, publish_time: 1700000000 },
        ema_price: { price: "340000000", conf: "140000", expo: -8, publish_time: 1700000000 },
        ...overrides,
    });
}

/** A realistic DEEP price data entry ($0.0215). */
export function makeDeepPriceData(overrides?: Partial<ParsedPriceData>): ParsedPriceData {
    return makePriceData({
        id: stripHexPrefix(DEEP_PRICE_FEED_ID),
        price: { price: "2150000", conf: "10000", expo: -8, publish_time: 1700000000 },
        ema_price: { price: "2100000", conf: "9000", expo: -8, publish_time: 1700000000 },
        ...overrides,
    });
}

/** A realistic USDC price data entry ($1.00). */
export function makeUsdcPriceData(overrides?: Partial<ParsedPriceData>): ParsedPriceData {
    return makePriceData({
        id: stripHexPrefix(USDC_PRICE_FEED_ID),
        price: { price: "100000000", conf: "5000", expo: -8, publish_time: 1700000000 },
        ema_price: { price: "100000000", conf: "4000", expo: -8, publish_time: 1700000000 },
        ...overrides,
    });
}

/** A complete PythPriceUpdate with all three feeds. */
export function makePythPriceUpdate(
    overrides?: Partial<{ sui: Partial<ParsedPriceData>; deep: Partial<ParsedPriceData>; usdc: Partial<ParsedPriceData> }>,
): PythPriceUpdate {
    return {
        binary: { encoding: "hex", data: ["deadbeef"] },
        parsed: [
            makeSuiPriceData(overrides?.sui),
            makeDeepPriceData(overrides?.deep),
            makeUsdcPriceData(overrides?.usdc),
        ],
    };
}

/** A test-friendly OracleConfig with short intervals. */
export function makeTestConfig(overrides?: Partial<OracleConfig>): OracleConfig {
    return {
        pythApiUrl: "https://benchmarks.pyth.network",
        priceFeeds: {
            sui: SUI_PRICE_FEED_ID,
            deep: DEEP_PRICE_FEED_ID,
            usdc: USDC_PRICE_FEED_ID,
        },
        updateIntervalMs: 1000,
        historicalDataHours: 24,
        ...overrides,
    };
}

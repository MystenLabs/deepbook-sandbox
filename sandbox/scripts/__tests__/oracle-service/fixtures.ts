import type { ParsedPriceData, PythPriceUpdate, OracleConfig } from "../../oracle-service/types";
import {
    SUI_PRICE_FEED_ID,
    DEEP_PRICE_FEED_ID,
    USDC_PRICE_FEED_ID,
} from "../../oracle-service/constants";

/** SUI at ~$3.45 */
export function makeSuiPriceData(overrides?: Partial<ParsedPriceData>): ParsedPriceData {
    return {
        id: SUI_PRICE_FEED_ID.slice(2),
        price: {
            price: "345000000",
            conf: "500000",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000) - 86400,
        },
        ema_price: {
            price: "340000000",
            conf: "600000",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000) - 86400,
        },
        ...overrides,
    };
}

/** DEEP at ~$0.02 */
export function makeDeepPriceData(overrides?: Partial<ParsedPriceData>): ParsedPriceData {
    return {
        id: DEEP_PRICE_FEED_ID.slice(2),
        price: {
            price: "2000000",
            conf: "50000",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000) - 86400,
        },
        ema_price: {
            price: "1950000",
            conf: "60000",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000) - 86400,
        },
        ...overrides,
    };
}

/** USDC at ~$1.00 */
export function makeUsdcPriceData(overrides?: Partial<ParsedPriceData>): ParsedPriceData {
    return {
        id: USDC_PRICE_FEED_ID.slice(2),
        price: {
            price: "100000000",
            conf: "100000",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000) - 86400,
        },
        ema_price: {
            price: "99990000",
            conf: "110000",
            expo: -8,
            publish_time: Math.floor(Date.now() / 1000) - 86400,
        },
        ...overrides,
    };
}

/** Complete Pyth API response with all three feeds */
export function makePythPriceUpdate(overrides?: Partial<PythPriceUpdate>): PythPriceUpdate {
    return {
        binary: { encoding: "hex", data: ["deadbeef"] },
        parsed: [makeSuiPriceData(), makeDeepPriceData(), makeUsdcPriceData()],
        ...overrides,
    };
}

/** OracleConfig with short intervals for testing */
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

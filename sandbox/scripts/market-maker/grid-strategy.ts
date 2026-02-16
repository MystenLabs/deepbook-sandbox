import type { MarketMakerConfig } from "./config";
import type { GridLevel } from "./types";

/**
 * Calculate grid levels around the mid price.
 *
 * Grid structure:
 * - N levels of bids below mid price
 * - N levels of asks above mid price
 * - Each level is spaced by levelSpacingBps from the previous
 * - The closest bid/ask are spreadBps/2 from mid price
 *
 * @param config - Market maker configuration
 * @param midPrice - Mid price from oracle. Falls back to config.fallbackMidPrice.
 */
export function calculateGridLevels(config: MarketMakerConfig, midPrice?: bigint): GridLevel[] {
    const { spreadBps, levelsPerSide, levelSpacingBps, orderSizeBase, tickSize, lotSize, minSize } =
        config;
    const effectiveMidPrice = midPrice ?? config.fallbackMidPrice;

    const levels: GridLevel[] = [];

    // Calculate half spread in price terms
    // spreadBps is in basis points (1 bp = 0.01%)
    // E.g., spreadBps=10 means 0.1% total spread, so 0.05% on each side
    // Use Math.floor to be explicit about integer division
    const halfSpreadBps = Math.floor(spreadBps / 2);
    const halfSpreadMultiplier = BigInt(10000 + halfSpreadBps);
    const baseMultiplier = 10000n;

    // Best ask = mid * (1 + spread/2)
    const bestAskPrice = alignToTickSize(
        (effectiveMidPrice * halfSpreadMultiplier) / baseMultiplier,
        tickSize,
        true, // round up for asks
    );

    // Best bid = mid * (1 - spread/2)
    const halfSpreadMultiplierBid = BigInt(10000 - halfSpreadBps);
    const bestBidPrice = alignToTickSize(
        (effectiveMidPrice * halfSpreadMultiplierBid) / baseMultiplier,
        tickSize,
        false, // round down for bids
    );

    // Calculate level spacing multiplier
    const levelSpacingMultiplier = BigInt(levelSpacingBps);

    // Calculate and validate order quantity
    const quantity = alignToLotSize(orderSizeBase, lotSize);
    if (quantity < minSize) {
        throw new Error(
            `Order size ${quantity} (aligned to lot size ${lotSize}) is below minimum ${minSize}. ` +
                `Increase orderSizeBase to at least ${minSize}.`,
        );
    }

    // Generate ask levels (above mid price)
    for (let i = 0; i < levelsPerSide; i++) {
        // Each level is levelSpacingBps higher than the previous
        const priceMultiplier = baseMultiplier + levelSpacingMultiplier * BigInt(i);
        const price = alignToTickSize(
            (bestAskPrice * priceMultiplier) / baseMultiplier,
            tickSize,
            true,
        );

        levels.push({
            price,
            quantity,
            isBid: false,
        });
    }

    // Generate bid levels (below mid price)
    for (let i = 0; i < levelsPerSide; i++) {
        // Each level is levelSpacingBps lower than the previous
        const priceMultiplier = baseMultiplier - levelSpacingMultiplier * BigInt(i);
        const price = alignToTickSize(
            (bestBidPrice * priceMultiplier) / baseMultiplier,
            tickSize,
            false,
        );

        // Skip if price would be zero or negative
        if (price <= 0n) continue;

        levels.push({
            price,
            quantity,
            isBid: true,
        });
    }

    return levels;
}

/**
 * Align price to tick size.
 * @param price - Raw price
 * @param tickSize - Tick size (minimum price increment)
 * @param roundUp - If true, round up; otherwise round down
 */
function alignToTickSize(price: bigint, tickSize: bigint, roundUp: boolean): bigint {
    const remainder = price % tickSize;
    if (remainder === 0n) return price;

    if (roundUp) {
        return price - remainder + tickSize;
    } else {
        return price - remainder;
    }
}

/**
 * Align quantity to lot size.
 * @param quantity - Raw quantity
 * @param lotSize - Lot size (minimum quantity increment)
 */
function alignToLotSize(quantity: bigint, lotSize: bigint): bigint {
    const remainder = quantity % lotSize;
    if (remainder === 0n) return quantity;
    return quantity - remainder;
}

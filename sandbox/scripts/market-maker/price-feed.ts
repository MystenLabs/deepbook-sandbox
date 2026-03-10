import type { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type { PoolConfig } from "./types";
import log from "../utils/logger";

/**
 * Read a u64 (8 bytes, little-endian) from a byte array at the given offset.
 */
function readU64LE(bytes: number[], offset: number): bigint {
    let value = 0n;
    for (let i = 0; i < 8; i++) {
        value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
    }
    return value;
}

/**
 * Parse a Pyth Price struct from BCS bytes returned by get_price_unsafe.
 *
 * BCS layout of Price { price: I64, conf: u64, expo: I64, timestamp: u64 }:
 *   - price.negative: 1 byte (bool)
 *   - price.magnitude: 8 bytes (u64 LE)
 *   - conf: 8 bytes (u64 LE)
 *   - expo.negative: 1 byte (bool)
 *   - expo.magnitude: 8 bytes (u64 LE)
 *   - timestamp: 8 bytes (u64 LE)
 */
function parsePriceFromBcs(bytes: number[]): { magnitude: bigint; exponent: bigint } {
    const priceNegative = bytes[0] !== 0;
    const priceMagnitude = readU64LE(bytes, 1);
    // conf at offset 9, skip 8 bytes
    const expoNegative = bytes[17] !== 0;
    const expoMagnitude = readU64LE(bytes, 18);

    if (priceNegative) {
        throw new Error("Negative price from oracle");
    }

    const exponent = expoNegative ? -BigInt(expoMagnitude) : BigInt(expoMagnitude);
    return { magnitude: priceMagnitude, exponent };
}

/**
 * Read a single Pyth price from an on-chain PriceInfoObject via devInspectTransactionBlock.
 */
async function readOnChainPrice(
    client: SuiClient,
    pythPackageId: string,
    priceInfoObjectId: string,
    sender: string,
): Promise<{ magnitude: bigint; exponent: bigint }> {
    const tx = new Transaction();
    tx.moveCall({
        target: `${pythPackageId}::pyth::get_price_unsafe`,
        arguments: [tx.object(priceInfoObjectId)],
    });

    const result = await client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender,
    });

    if (result.effects.status.status !== "success") {
        throw new Error(`devInspect failed: ${result.effects.status.error ?? "unknown"}`);
    }

    const returnValues = result.results?.[0]?.returnValues;
    if (!returnValues || returnValues.length === 0) {
        throw new Error("No return values from get_price_unsafe");
    }

    const [bytes] = returnValues[0];
    return parsePriceFromBcs(bytes);
}

/**
 * Fetch the base/quote mid price from on-chain Pyth PriceInfoObjects.
 *
 * Reads base/USD and quote/USD prices via devInspectTransactionBlock,
 * then computes: base/quote = (base_USD / quote_USD) scaled to quoteDecimals.
 *
 * @returns mid price as bigint in quote asset's decimal format, or null if read fails
 */
export async function fetchOracleMidPrice(
    client: SuiClient,
    pool: PoolConfig,
    pythPackageId: string,
    sender: string,
): Promise<bigint | null> {
    if (!pool.basePriceInfoObjectId || !pool.quotePriceInfoObjectId) {
        return null;
    }

    try {
        const [basePrice, quotePrice] = await Promise.all([
            readOnChainPrice(client, pythPackageId, pool.basePriceInfoObjectId, sender),
            readOnChainPrice(client, pythPackageId, pool.quotePriceInfoObjectId, sender),
        ]);

        if (basePrice.magnitude === 0n || quotePrice.magnitude === 0n) {
            log.loopError("Oracle returned zero price");
            return null;
        }

        const midPrice = calculateBaseQuotePrice(basePrice, quotePrice, pool.quoteDecimals);
        if (midPrice <= 0n) {
            log.loopError("Oracle returned non-positive price");
            return null;
        }

        return midPrice;
    } catch (error) {
        log.loopError("Failed to read on-chain oracle", error);
        return null;
    }
}

/**
 * Calculate base/quote price from oracle USD prices.
 *
 * Each price is: actual_price = magnitude * 10^exponent
 * base/quote = base_USD / quote_USD, scaled to quoteDecimals.
 *
 * result = baseMag * 10^(quoteDecimals + baseExpo - quoteExpo) / quoteMag
 */
function calculateBaseQuotePrice(
    base: { magnitude: bigint; exponent: bigint },
    quote: { magnitude: bigint; exponent: bigint },
    quoteDecimals: number,
): bigint {
    const scaledExpo = BigInt(quoteDecimals) + base.exponent - quote.exponent;

    if (scaledExpo >= 0n) {
        return (base.magnitude * 10n ** scaledExpo) / quote.magnitude;
    } else {
        return base.magnitude / (quote.magnitude * 10n ** -scaledExpo);
    }
}

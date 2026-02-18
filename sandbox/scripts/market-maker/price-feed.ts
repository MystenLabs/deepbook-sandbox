import type { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type { DeploymentManifest } from "./types";
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
 * Fetch the DEEP/SUI mid price from on-chain Pyth PriceInfoObjects.
 *
 * Reads DEEP/USD and SUI/USD prices via devInspectTransactionBlock,
 * then computes: DEEP/SUI = (DEEP_USD / SUI_USD) scaled to 9 decimals.
 *
 * @returns mid price as bigint in SUI's 9-decimal format, or null if read fails
 */
export async function fetchOracleMidPrice(
    client: SuiClient,
    manifest: DeploymentManifest,
): Promise<bigint | null> {
    if (!manifest.pythOracles) {
        return null;
    }

    const pythPackageId = manifest.packages.pyth?.packageId;
    if (!pythPackageId) {
        return null;
    }

    try {
        const sender = manifest.deployerAddress;

        const [deepPrice, suiPrice] = await Promise.all([
            readOnChainPrice(
                client,
                pythPackageId,
                manifest.pythOracles.deepPriceInfoObjectId,
                sender,
            ),
            readOnChainPrice(
                client,
                pythPackageId,
                manifest.pythOracles.suiPriceInfoObjectId,
                sender,
            ),
        ]);

        if (deepPrice.magnitude === 0n || suiPrice.magnitude === 0n) {
            log.loopError("Oracle returned zero price");
            return null;
        }

        const midPrice = calculateDeepSuiPrice(deepPrice, suiPrice);
        if (midPrice <= 0n) {
            log.loopError("Oracle returned non-positive DEEP/SUI price");
            return null;
        }

        return midPrice;
    } catch (error) {
        log.loopError("Failed to read on-chain oracle", error);
        return null;
    }
}

/**
 * Calculate DEEP/SUI price from oracle USD prices.
 *
 * Each price is: actual_price = magnitude * 10^exponent
 * DEEP/SUI = DEEP_USD / SUI_USD, scaled to 9 decimals (SUI native units).
 *
 * result = deepMag * 10^(9 + deepExpo - suiExpo) / suiMag
 */
function calculateDeepSuiPrice(
    deep: { magnitude: bigint; exponent: bigint },
    sui: { magnitude: bigint; exponent: bigint },
): bigint {
    const scaledExpo = 9n + deep.exponent - sui.exponent;

    if (scaledExpo >= 0n) {
        return (deep.magnitude * 10n ** scaledExpo) / sui.magnitude;
    } else {
        return deep.magnitude / (sui.magnitude * 10n ** -scaledExpo);
    }
}

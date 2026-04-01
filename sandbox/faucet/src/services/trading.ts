/**
 * Read-only pool query service.
 *
 * Calls on-chain Move view functions via simulateTransaction to read
 * pool details (mid price, book params, order book depth).
 * No signing or concurrency lock needed.
 */

import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

const SUI_CLOCK_OBJECT_ID = "0x6";

/* ------------------------------------------------------------------ */
/*  BCS parse helpers                                                  */
/* ------------------------------------------------------------------ */

/** Read a u64 (8 bytes, little-endian) from a Uint8Array. */
function parseU64(bcs: Uint8Array): bigint {
    let value = 0n;
    for (let i = 0; i < 8; i++) {
        value |= BigInt(bcs[i]) << BigInt(i * 8);
    }
    return value;
}

/**
 * Parse a BCS-encoded `vector<u64>`.
 * Layout: ULEB128 length prefix, then `length` packed 8-byte LE u64 values.
 */
function parseVecU64(bcs: Uint8Array): bigint[] {
    let offset = 0;

    // ULEB128 length prefix
    let length = 0;
    let shift = 0;
    while (offset < bcs.length) {
        const byte = bcs[offset++];
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }

    const result: bigint[] = [];
    for (let i = 0; i < length; i++) {
        let value = 0n;
        for (let j = 0; j < 8; j++) {
            value |= BigInt(bcs[offset + j]) << BigInt(j * 8);
        }
        offset += 8;
        result.push(value);
    }
    return result;
}

/* ------------------------------------------------------------------ */
/*  Pool query functions                                               */
/* ------------------------------------------------------------------ */

/**
 * Read the pool's mid price (midpoint between best bid and best ask).
 * Calls `pool::mid_price<Base, Quote>(pool, clock) -> u64`.
 */
export async function getMidPrice(
    client: SuiGrpcClient,
    sender: string,
    packageId: string,
    poolId: string,
    baseType: string,
    quoteType: string,
): Promise<bigint> {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: `${packageId}::pool::mid_price`,
        typeArguments: [baseType, quoteType],
        arguments: [tx.object(poolId), tx.object(SUI_CLOCK_OBJECT_ID)],
    });

    const result = await client.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(`mid_price failed: ${result.FailedTransaction.status.error ?? "unknown"}`);
    }

    const bcs = result.commandResults?.[0]?.returnValues?.[0]?.bcs;
    if (!bcs || bcs.length === 0) return 0n;
    return parseU64(bcs);
}

/**
 * Read pool book parameters (tick size, lot size, min size).
 * Calls `pool::pool_book_params<Base, Quote>(pool) -> (u64, u64, u64)`.
 */
export async function getBookParams(
    client: SuiGrpcClient,
    sender: string,
    packageId: string,
    poolId: string,
    baseType: string,
    quoteType: string,
): Promise<{ tickSize: bigint; lotSize: bigint; minSize: bigint }> {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: `${packageId}::pool::pool_book_params`,
        typeArguments: [baseType, quoteType],
        arguments: [tx.object(poolId)],
    });

    const result = await client.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(
            `pool_book_params failed: ${result.FailedTransaction.status.error ?? "unknown"}`,
        );
    }

    const rv = result.commandResults?.[0]?.returnValues;
    if (!rv || rv.length < 3) {
        throw new Error("pool_book_params returned unexpected number of values");
    }

    return {
        tickSize: parseU64(rv[0].bcs),
        lotSize: parseU64(rv[1].bcs),
        minSize: parseU64(rv[2].bcs),
    };
}

/**
 * Read order book depth (N ticks from mid price on each side).
 * Calls `pool::get_level2_ticks_from_mid<Base, Quote>(pool, ticks, clock)
 *   -> (vec<u64>, vec<u64>, vec<u64>, vec<u64>)`.
 *
 * Returns: bid_prices, bid_quantities, ask_prices, ask_quantities.
 */
export async function getOrderBookDepth(
    client: SuiGrpcClient,
    sender: string,
    packageId: string,
    poolId: string,
    baseType: string,
    quoteType: string,
    ticks: number,
): Promise<{
    bidPrices: bigint[];
    bidQuantities: bigint[];
    askPrices: bigint[];
    askQuantities: bigint[];
}> {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
        target: `${packageId}::pool::get_level2_ticks_from_mid`,
        typeArguments: [baseType, quoteType],
        arguments: [tx.object(poolId), tx.pure.u64(ticks), tx.object(SUI_CLOCK_OBJECT_ID)],
    });

    const result = await client.simulateTransaction({
        transaction: tx,
        checksEnabled: false,
        include: { commandResults: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(
            `get_level2_ticks_from_mid failed: ${result.FailedTransaction.status.error ?? "unknown"}`,
        );
    }

    const rv = result.commandResults?.[0]?.returnValues;
    if (!rv || rv.length < 4) {
        return { bidPrices: [], bidQuantities: [], askPrices: [], askQuantities: [] };
    }

    return {
        bidPrices: parseVecU64(rv[0].bcs),
        bidQuantities: parseVecU64(rv[1].bcs),
        askPrices: parseVecU64(rv[2].bcs),
        askQuantities: parseVecU64(rv[3].bcs),
    };
}

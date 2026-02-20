import type { SuiClient } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import type { SuiObjectChangeCreated } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import type { DeploymentResult } from "./deployer";
import {
    SUI_PRICE_FEED_ID,
    DEEP_PRICE_FEED_ID,
    USDC_PRICE_FEED_ID,
} from "../oracle-service/constants";
import log from "./logger";

const SUI_PRICE_FEED_ID_BYTES = fromHex(SUI_PRICE_FEED_ID);
const DEEP_PRICE_FEED_ID_BYTES = fromHex(DEEP_PRICE_FEED_ID);
const USDC_PRICE_FEED_ID_BYTES = fromHex(USDC_PRICE_FEED_ID);

export interface PythOracleIds {
    deepPriceInfoObjectId: string;
    suiPriceInfoObjectId: string;
    usdcPriceInfoObjectId: string;
}

/** Add Move calls for one price feed (identifier → price → price_feed → price_info); returns the price_info result. */
function addPriceInfoToTx(
    tx: Transaction,
    packageId: string,
    params: { idBytes: Uint8Array; priceMag: number; expoMag: number },
    timestamp: number,
) {
    const { idBytes, priceMag, expoMag } = params;
    const priceI64 = tx.moveCall({
        target: `${packageId}::i64::new`,
        arguments: [tx.pure.u64(priceMag), tx.pure.bool(false)],
    });
    const expoI64 = tx.moveCall({
        target: `${packageId}::i64::new`,
        arguments: [tx.pure.u64(expoMag), tx.pure.bool(true)],
    });
    const price = tx.moveCall({
        target: `${packageId}::price::new`,
        arguments: [priceI64, tx.pure.u64(0), expoI64, tx.pure.u64(timestamp)],
    });
    const priceIdentifier = tx.moveCall({
        target: `${packageId}::price_identifier::from_byte_vec`,
        arguments: [tx.pure.vector("u8", Array.from(idBytes))],
    });
    const priceFeed = tx.moveCall({
        target: `${packageId}::price_feed::new`,
        arguments: [priceIdentifier, price, price],
    });
    return tx.moveCall({
        target: `${packageId}::price_info::new_price_info`,
        arguments: [tx.pure.u64(timestamp), tx.pure.u64(timestamp), priceFeed],
    });
}

/**
 * Create DEEP and SUI PriceInfoObjects via pyth::pyth::create_price_feeds.
 * Uses official Pyth Network price feed identifiers.
 */
export async function setupPythOracles(
    client: SuiClient,
    signer: Keypair,
    deployedPackages: Map<string, DeploymentResult>,
): Promise<PythOracleIds> {
    const pythPkg = deployedPackages.get("pyth");
    if (!pythPkg) {
        throw new Error("pyth package not found in deployed packages");
    }

    const timestamp = 0;
    const tx = new Transaction();
    tx.setGasBudget(200_000_000);

    const deepPriceInfo = addPriceInfoToTx(
        tx,
        pythPkg.packageId,
        { idBytes: DEEP_PRICE_FEED_ID_BYTES, priceMag: 2_000_000, expoMag: 8 },
        timestamp,
    );
    const suiPriceInfo = addPriceInfoToTx(
        tx,
        pythPkg.packageId,
        { idBytes: SUI_PRICE_FEED_ID_BYTES, priceMag: 100_000_000, expoMag: 8 },
        timestamp,
    );
    const usdcPriceInfo = addPriceInfoToTx(
        tx,
        pythPkg.packageId,
        { idBytes: USDC_PRICE_FEED_ID_BYTES, priceMag: 100_000_000, expoMag: 8 },
        timestamp,
    );

    tx.moveCall({
        target: `${pythPkg.packageId}::pyth::create_price_feeds`,
        arguments: [
            tx.makeMoveVec({
                type: `${pythPkg.packageId}::price_info::PriceInfo`,
                elements: [deepPriceInfo, suiPriceInfo, usdcPriceInfo],
            }),
        ],
    });

    const result = await client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: {
            showEffects: true,
            showObjectChanges: true,
        },
    });

    if (result.effects?.status.status !== "success") {
        throw new Error(
            `Failed to create pyth oracles: ${result.effects?.status.error ?? "Unknown error"}`,
        );
    }

    const created = (result.objectChanges ?? []).filter(
        (obj): obj is SuiObjectChangeCreated =>
            obj.type === "created" &&
            typeof obj.objectType === "string" &&
            obj.objectType.includes("::price_info::PriceInfoObject"),
    );

    if (created.length !== 3) {
        throw new Error(`Expected 3 PriceInfoObject created, got ${created.length}`);
    }

    await client.waitForTransaction({ digest: result.digest });

    const priceObjects = await client.multiGetObjects({
        ids: created.map((obj) => obj.objectId),
        options: {
            showContent: true,
        },
    });

    const feedIdToObjectId = new Map<string, string>();
    for (const obj of priceObjects) {
        const bytes: number[] = (obj.data?.content as any).fields.price_info.fields.price_feed
            .fields.price_identifier.fields.bytes;
        feedIdToObjectId.set("0x" + toHex(new Uint8Array(bytes)), obj.data!.objectId);
    }

    const ids: PythOracleIds = {
        deepPriceInfoObjectId: feedIdToObjectId.get(DEEP_PRICE_FEED_ID)!,
        suiPriceInfoObjectId: feedIdToObjectId.get(SUI_PRICE_FEED_ID)!,
        usdcPriceInfoObjectId: feedIdToObjectId.get(USDC_PRICE_FEED_ID)!,
    };

    log.success(`DEEP PriceInfoObject: ${ids.deepPriceInfoObjectId}`);
    log.success(`SUI PriceInfoObject: ${ids.suiPriceInfoObjectId}`);
    console.log(`    ✅ USDC PriceInfoObject: ${ids.usdcPriceInfoObjectId}`);

    return ids;
}

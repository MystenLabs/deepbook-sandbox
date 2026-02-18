import type { SuiClient } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import type { ParsedPriceData } from "./types";
import { SUI_PRICE_FEED_ID, DEEP_PRICE_FEED_ID } from "./constants";
import { fromHex } from "@mysten/sui/utils";
import log from "../utils/logger";

/**
 * Handles updating Pyth oracle contracts on Sui
 */
export class OracleUpdater {
    constructor(
        private client: SuiClient,
        private signer: Keypair,
        private pythPackageId: string,
    ) {}

    /**
     * Updates both SUI and DEEP price feeds on-chain
     */
    async updatePriceFeeds(
        priceData: ParsedPriceData[],
        priceInfoObjectIds: { sui: string; deep: string },
    ): Promise<void> {
        log.loop("Updating on-chain price feeds");
        const suiData = priceData.find((p) => p.id === SUI_PRICE_FEED_ID.slice(2));
        const deepData = priceData.find((p) => p.id === DEEP_PRICE_FEED_ID.slice(2));

        if (!suiData || !deepData) {
            throw new Error("Missing price data: SUI or DEEP not found in Pyth response");
        }

        const tx = new Transaction();
        tx.setGasBudget(200_000_000);

        // Update SUI price feed
        const suiPriceInfo = this.buildPriceInfo(tx, suiData);
        tx.moveCall({
            target: `${this.pythPackageId}::pyth::update_single_price_feed`,
            arguments: [suiPriceInfo, tx.object(priceInfoObjectIds.sui)],
        });

        // Update DEEP price feed
        const deepPriceInfo = this.buildPriceInfo(tx, deepData);
        tx.moveCall({
            target: `${this.pythPackageId}::pyth::update_single_price_feed`,
            arguments: [deepPriceInfo, tx.object(priceInfoObjectIds.deep)],
        });

        try {
            const result = await this.client.signAndExecuteTransaction({
                transaction: tx,
                signer: this.signer,
                options: {
                    showEffects: true,
                },
            });

            if (result.effects?.status.status !== "success") {
                throw new Error(
                    `Transaction failed: ${result.effects?.status.error ?? "Unknown error"}`,
                );
            }

            log.loopSuccess(`Updated price feeds (digest: ${result.digest})`);
            this.logPriceData(suiData, deepData);
        } catch (error) {
            log.loopError("Failed to update price feeds", error);
            throw error;
        }
    }

    /**
     * Builds a PriceInfo object from Pyth price data
     */
    private buildPriceInfo(tx: Transaction, data: ParsedPriceData): ReturnType<typeof tx.moveCall> {
        const { price, ema_price } = data;

        // Convert price string to magnitude (remove negative sign if present)
        const priceMag = Math.abs(Number.parseInt(price.price));
        const emaPriceMag = Math.abs(Number.parseInt(ema_price.price));

        // Determine if prices are negative
        const priceNegative = Number.parseInt(price.price) < 0;
        const emaPriceNegative = Number.parseInt(ema_price.price) < 0;

        // Expo is already negative in Pyth data, we need the magnitude
        const expoMag = Math.abs(price.expo);
        const emaExpoMag = Math.abs(ema_price.expo);

        // Build price I64
        const priceI64 = tx.moveCall({
            target: `${this.pythPackageId}::i64::new`,
            arguments: [tx.pure.u64(priceMag), tx.pure.bool(priceNegative)],
        });

        const priceExpoI64 = tx.moveCall({
            target: `${this.pythPackageId}::i64::new`,
            arguments: [tx.pure.u64(expoMag), tx.pure.bool(true)], // expo is always negative
        });

        const priceObj = tx.moveCall({
            target: `${this.pythPackageId}::price::new`,
            arguments: [
                priceI64,
                tx.pure.u64(Number.parseInt(price.conf)),
                priceExpoI64,
                tx.pure.u64(price.publish_time),
            ],
        });

        // Build EMA price I64
        const emaPriceI64 = tx.moveCall({
            target: `${this.pythPackageId}::i64::new`,
            arguments: [tx.pure.u64(emaPriceMag), tx.pure.bool(emaPriceNegative)],
        });

        const emaExpoI64 = tx.moveCall({
            target: `${this.pythPackageId}::i64::new`,
            arguments: [tx.pure.u64(emaExpoMag), tx.pure.bool(true)], // expo is always negative
        });

        const emaPriceObj = tx.moveCall({
            target: `${this.pythPackageId}::price::new`,
            arguments: [
                emaPriceI64,
                tx.pure.u64(Number.parseInt(ema_price.conf)),
                emaExpoI64,
                tx.pure.u64(ema_price.publish_time),
            ],
        });

        // Build price identifier (32 bytes)
        const priceIdBytes = fromHex(data.id);
        const priceIdentifier = tx.moveCall({
            target: `${this.pythPackageId}::price_identifier::from_byte_vec`,
            arguments: [tx.pure.vector("u8", Array.from(priceIdBytes))],
        });

        // Build price feed
        const priceFeed = tx.moveCall({
            target: `${this.pythPackageId}::price_feed::new`,
            arguments: [priceIdentifier, priceObj, emaPriceObj],
        });

        // Build and return price info
        const timestamp = price.publish_time;
        return tx.moveCall({
            target: `${this.pythPackageId}::price_info::new_price_info`,
            arguments: [tx.pure.u64(timestamp), tx.pure.u64(timestamp), priceFeed],
        });
    }

    /**
     * Logs price data in a readable format
     */
    private logPriceData(suiData: ParsedPriceData, deepData: ParsedPriceData) {
        const formatPrice = (price: string, expo: number) => {
            const priceNum = Number.parseInt(price);
            const formatted = priceNum * Math.pow(10, expo);
            return formatted.toFixed(Math.abs(expo));
        };

        log.loopDetail(`SUI:  $${formatPrice(suiData.price.price, suiData.price.expo)}`);
        log.loopDetail(`DEEP: $${formatPrice(deepData.price.price, deepData.price.expo)}`);
    }
}

import type { SuiClient, SuiEvent } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { ORDER_TYPE, SELF_MATCHING, SUI_CLOCK_OBJECT_ID, explorerTxUrl } from "./types";
import type { ActiveOrder, GridLevel } from "./types";
import { updateMetrics } from "./metrics";
import log from "../utils/logger";

export class OrderManager {
    private activeOrders: Map<string, ActiveOrder> = new Map();
    // Use timestamp-based counter to avoid conflicts across restarts
    private clientOrderIdCounter = BigInt(Date.now()) * 1000n;

    constructor(
        private client: SuiClient,
        private signer: Keypair,
        private packageId: string,
        private poolId: string,
        private baseType: string,
        private quoteType: string,
        private balanceManagerId: string,
        private network: string,
    ) {}

    /**
     * Place multiple limit orders in a single transaction.
     */
    async placeOrders(levels: GridLevel[]): Promise<string[]> {
        if (levels.length === 0) return [];

        const tx = new Transaction();
        const placedOrderIds: string[] = [];
        const clientOrderIds: bigint[] = [];

        // Generate trade proof first (required for all orders)
        const tradeProof = tx.moveCall({
            target: `${this.packageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(this.balanceManagerId)],
        });

        // Place each order
        for (const level of levels) {
            const clientOrderId = this.clientOrderIdCounter++;
            clientOrderIds.push(clientOrderId);

            // No expiration (max u64)
            const expireTimestamp = BigInt("18446744073709551615");

            tx.moveCall({
                target: `${this.packageId}::pool::place_limit_order`,
                typeArguments: [this.baseType, this.quoteType],
                arguments: [
                    tx.object(this.poolId), // pool
                    tx.object(this.balanceManagerId), // balance_manager
                    tradeProof, // trade_proof
                    tx.pure.u64(clientOrderId), // client_order_id
                    tx.pure.u8(ORDER_TYPE.POST_ONLY), // order_type (POST_ONLY for market maker)
                    tx.pure.u8(SELF_MATCHING.CANCEL_TAKER), // self_matching_option
                    tx.pure.u64(level.price), // price
                    tx.pure.u64(level.quantity), // quantity
                    tx.pure.bool(level.isBid), // is_bid
                    tx.pure.bool(false), // pay_with_deep (false for whitelisted pools with no DEEP)
                    tx.pure.u64(expireTimestamp), // expire_timestamp
                    tx.object(SUI_CLOCK_OBJECT_ID), // clock
                ],
            });
        }

        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            options: {
                showEffects: true,
                showEvents: true,
            },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to place orders: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        // Wait for the place transaction to finalize so object versions are updated
        await this.client.waitForTransaction({
            digest: result.digest,
        });

        // Extract order IDs from events
        const events = result.events || [];
        const orderPlacedEvents = events.filter((e) => e.type.includes("::OrderPlaced"));

        let missingOrderIds = 0;
        for (let i = 0; i < levels.length; i++) {
            const event = orderPlacedEvents[i];
            const orderId = event ? extractOrderIdFromEvent(event) : null;
            if (orderId) {
                placedOrderIds.push(orderId);
                const level = levels[i];
                this.activeOrders.set(orderId, {
                    orderId,
                    clientOrderId: clientOrderIds[i],
                    price: level.price,
                    quantity: level.quantity,
                    isBid: level.isBid,
                    placedAt: new Date(),
                });
            } else {
                missingOrderIds++;
            }
        }

        if (missingOrderIds > 0) {
            log.warn(`Could not extract order IDs for ${missingOrderIds} orders`);
        }

        // Update metrics
        updateMetrics({
            ordersPlaced: levels.length,
            activeOrders: this.activeOrders.size,
        });

        log.loopDetail(`Placed ${placedOrderIds.length} orders`);
        log.loopDetail(explorerTxUrl(result.digest, this.network));
        return placedOrderIds;
    }

    /**
     * Cancel all orders for the balance manager in the pool.
     */
    async cancelAllOrders(): Promise<string> {
        const tx = new Transaction();

        // Generate trade proof
        const tradeProof = tx.moveCall({
            target: `${this.packageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(this.balanceManagerId)],
        });

        // Cancel all orders
        tx.moveCall({
            target: `${this.packageId}::pool::cancel_all_orders`,
            typeArguments: [this.baseType, this.quoteType],
            arguments: [
                tx.object(this.poolId), // pool
                tx.object(this.balanceManagerId), // balance_manager
                tradeProof, // trade_proof
                tx.object(SUI_CLOCK_OBJECT_ID), // clock
            ],
        });

        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            options: {
                showEffects: true,
            },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to cancel orders: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        // Wait for the cancel transaction to finalize so object versions are updated
        await this.client.waitForTransaction({
            digest: result.digest,
        });

        const canceledCount = this.activeOrders.size;
        this.activeOrders.clear();

        // Update metrics
        updateMetrics({
            ordersCanceled: canceledCount,
            activeOrders: 0,
        });

        log.loopDetail(`Canceled ${canceledCount} orders`);
        log.loopDetail(explorerTxUrl(result.digest, this.network));
        return result.digest;
    }

    /**
     * Get currently tracked active orders.
     */
    getActiveOrders(): ActiveOrder[] {
        return Array.from(this.activeOrders.values());
    }

    /**
     * Get count of active orders.
     */
    getActiveOrderCount(): number {
        return this.activeOrders.size;
    }
}

/**
 * Extract order ID from OrderPlaced event.
 * The event structure may vary, so we try multiple field names.
 */
function extractOrderIdFromEvent(event: SuiEvent): string | null {
    const parsedJson = event.parsedJson as Record<string, unknown> | undefined;
    if (!parsedJson) return null;

    // Try common field names for order ID
    const possibleFields = ["order_id", "orderId", "id"];
    for (const field of possibleFields) {
        if (field in parsedJson) {
            const value = parsedJson[field];
            if (typeof value === "string") return value;
            if (typeof value === "bigint" || typeof value === "number") return String(value);
        }
    }

    return null;
}

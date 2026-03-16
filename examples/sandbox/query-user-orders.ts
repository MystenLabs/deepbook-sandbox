/**
 * Query User Orders — Full order lifecycle example
 *
 * Demonstrates the complete lifecycle of an order:
 *   1. Place a resting limit order (far from market)
 *   2. Query open orders via accountOpenOrders
 *   3. Get detailed order info via getAccountOrderDetails
 *   4. Cancel all orders
 *   5. Verify the order book is empty
 *
 * This is useful for building trading dashboards or order management systems.
 *
 * Usage: pnpm query-user-orders
 */

import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import { Transaction } from "@mysten/sui/transactions";
import { setupWithBalanceManager, signAndExecute } from "./setup.js";

async function main() {
    const { client, keypair, balanceManagerKey } = await setupWithBalanceManager();

    // --- Step 1: Deposit and place a resting limit order ---

    const setupTx = new Transaction();

    // Deposit SUI for bidding
    client.deepbook.balanceManager.depositIntoManager(balanceManagerKey, "SUI", 1)(setupTx);

    // Place a limit BID far below market (~0.01 SUI) so it definitely rests
    client.deepbook.deepBook.placeLimitOrder({
        poolKey: "DEEP_SUI",
        balanceManagerKey,
        clientOrderId: "42",
        price: 0.01,
        quantity: 10,
        isBid: true,
        orderType: OrderType.NO_RESTRICTION,
        selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
        payWithDeep: false,
    })(setupTx);

    console.log("Depositing SUI and placing limit order...");
    await signAndExecute(client, keypair, setupTx);
    console.log("Order placed.\n");

    // --- Step 2: Query open orders ---

    // accountOpenOrders returns an array of order IDs for this balance manager
    const openOrders = await client.deepbook.accountOpenOrders("DEEP_SUI", balanceManagerKey);
    console.log(`Open orders (${openOrders.length}):`);
    for (const orderId of openOrders) {
        console.log(`  Order ID: ${orderId}`);
    }

    // --- Step 3: Get detailed order info ---

    // getAccountOrderDetails returns full order state including
    // quantity, filled quantity, status, and expiration
    const details = await client.deepbook.getAccountOrderDetails("DEEP_SUI", balanceManagerKey);
    console.log(`\nOrder details (${details.length}):`);
    for (const order of details) {
        console.log(`  Order ${order.order_id}:`);
        console.log(`    Client ID:  ${order.client_order_id}`);
        console.log(`    Quantity:   ${order.quantity}`);
        console.log(`    Filled:     ${order.filled_quantity}`);
        console.log(`    Status:     ${order.status}`);
        console.log(`    Fee is DEEP: ${order.fee_is_deep}`);
    }

    // --- Step 4: Cancel all orders ---

    // cancelAllOrders removes every open order for this balance manager
    // (vs cancelOrder which targets a single order by ID)
    const cancelTx = new Transaction();
    client.deepbook.deepBook.cancelAllOrders("DEEP_SUI", balanceManagerKey)(cancelTx);

    console.log("\nCanceling all orders...");
    await signAndExecute(client, keypair, cancelTx);
    console.log("Orders canceled.\n");

    // --- Step 5: Verify cancellation ---

    const remaining = await client.deepbook.accountOpenOrders("DEEP_SUI", balanceManagerKey);
    console.log(`Open orders after cancel: ${remaining.length}`);

    if (remaining.length === 0) {
        console.log("All orders successfully canceled.");
    } else {
        console.log("Warning: some orders remain:", remaining);
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
});

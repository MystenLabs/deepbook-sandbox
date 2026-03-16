/**
 * Place Limit Order — BalanceManager + limit order example
 *
 * Demonstrates the full flow for placing a resting limit order:
 *   1. Create a BalanceManager (shared object that holds trading balances)
 *   2. Deposit SUI into the BalanceManager
 *   3. Place a limit BID below market price (so it rests on the book)
 *   4. Verify the order exists via accountOpenOrders
 *
 * A BalanceManager is required for all order operations in DeepBook.
 * It acts as an escrow account — funds are deposited into it before
 * trading and settled back after fills.
 *
 * Usage: pnpm place-limit-order
 */

import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import { Transaction } from "@mysten/sui/transactions";
import { setupWithBalanceManager, signAndExecute } from "./setup.js";

async function main() {
    const { client, keypair, balanceManagerKey } = await setupWithBalanceManager();

    // Deposit 1 SUI into the BalanceManager.
    // This makes SUI available for placing bids on the DEEP/SUI pool.
    const depositTx = new Transaction();
    client.deepbook.balanceManager.depositIntoManager(balanceManagerKey, "SUI", 1)(depositTx);

    console.log("Depositing 1 SUI into BalanceManager...");
    await signAndExecute(client, keypair, depositTx);
    console.log("Deposit confirmed.\n");

    // Place a limit BID at 0.05 SUI per DEEP — well below the ~0.1 market price.
    // This ensures the order rests on the book rather than filling immediately.
    //
    // Order types:
    //   NO_RESTRICTION  — standard limit order (rests if not matched)
    //   POST_ONLY       — rejected if it would trade immediately
    //   IMMEDIATE_OR_CANCEL — fills what it can, cancels the rest
    //   FILL_OR_KILL    — must fill entirely or not at all
    //
    // payWithDeep: false because DEEP/SUI is a whitelisted pool
    // (fees are paid from the traded coins, not from DEEP balance)
    const orderTx = new Transaction();
    client.deepbook.deepBook.placeLimitOrder({
        poolKey: "DEEP_SUI",
        balanceManagerKey,
        clientOrderId: "1",
        price: 0.05,
        quantity: 10,
        isBid: true,
        orderType: OrderType.NO_RESTRICTION,
        selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
        payWithDeep: false,
    })(orderTx);

    console.log("Placing limit BID: 10 DEEP @ 0.05 SUI...");
    const result = await signAndExecute(client, keypair, orderTx);
    console.log(`Order placed. Transaction digest: ${result.digest}\n`);

    // Verify the order is resting on the book
    const openOrders = await client.deepbook.accountOpenOrders("DEEP_SUI", balanceManagerKey);
    console.log(`Open orders: ${openOrders.length}`);
    for (const orderId of openOrders) {
        console.log(`  Order ID: ${orderId}`);
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
});

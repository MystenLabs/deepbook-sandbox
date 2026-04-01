/**
 * Place Market Order — Market buy against market maker liquidity
 *
 * Demonstrates placing a market order that fills immediately against
 * resting orders from the sandbox market maker.
 *
 * Unlike limit orders which rest on the book at a specific price,
 * market orders execute at the best available price. They require
 * liquidity on the opposite side — the sandbox market maker provides this.
 *
 * Prerequisites: The sandbox must be running with the market maker active.
 * Wait 10-15 seconds after `pnpm deploy-all` completes.
 *
 * Usage: pnpm place-market-order
 */

import { SelfMatchingOptions } from "@mysten/deepbook-v3";
import { Transaction } from "@mysten/sui/transactions";
import { setupWithBalanceManager, signAndExecute } from "./setup.js";

async function main() {
    const { client, keypair, balanceManagerKey } = await setupWithBalanceManager();

    // Deposit SUI to cover the purchase cost + potential fees
    const depositTx = new Transaction();
    client.deepbook.balanceManager.depositIntoManager(balanceManagerKey, "SUI", 5)(depositTx);

    console.log("Depositing 5 SUI into BalanceManager...");
    await signAndExecute(client, keypair, depositTx);
    console.log("Deposit confirmed.\n");

    // Place a market BUY for 10 DEEP.
    // This will fill against the market maker's resting asks at the best price.
    //
    // Market orders don't specify a price — they take the best available.
    // The quantity is in base units (DEEP).
    const orderTx = new Transaction();
    client.deepbook.deepBook.placeMarketOrder({
        poolKey: "DEEP_SUI",
        balanceManagerKey,
        clientOrderId: "1",
        quantity: 10,
        isBid: true,
        selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
        payWithDeep: false,
    })(orderTx);

    console.log("Placing market BUY: 10 DEEP...");
    const result = await signAndExecute(client, keypair, orderTx);
    console.log(`Order executed. Transaction digest: ${result.digest}\n`);

    // Check the BalanceManager balance to confirm the fill.
    // checkManagerBalance returns { coinType, balance } with the balance in human units.
    const { balance } = await client.deepbook.checkManagerBalance(balanceManagerKey, "DEEP");
    console.log(`DEEP balance in BalanceManager: ${balance}`);

    console.log("\nDone.");
}

main().catch((err) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
});

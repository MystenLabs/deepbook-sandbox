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
import { setupWithBalanceManager, signAndExecute, waitForLiquidity } from "./setup.js";

/** How many times to re-place the order if the ask side empties under us. */
const MAX_ATTEMPTS = 3;

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
    //
    // A market order is immediate-or-cancel. If the ask side happens to be empty
    // it matches nothing, yet the transaction still succeeds and returns a digest.
    // So we wait for depth, then prove the fill from the balance delta rather than
    // trusting the digest. The market maker empties the book on every rebalance,
    // so an attempt can still lose the race — hence the retry.
    let filled = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await waitForLiquidity(client, "DEEP_SUI", "ask");

        // checkManagerBalance returns { coinType, balance } with balance in human units.
        const before = Number(
            (await client.deepbook.checkManagerBalance(balanceManagerKey, "DEEP")).balance,
        );

        const orderTx = new Transaction();
        client.deepbook.deepBook.placeMarketOrder({
            poolKey: "DEEP_SUI",
            balanceManagerKey,
            clientOrderId: String(attempt),
            quantity: 10,
            isBid: true,
            selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
            payWithDeep: false,
        })(orderTx);

        console.log(`Placing market BUY: 10 DEEP (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const result = await signAndExecute(client, keypair, orderTx);

        const after = Number(
            (await client.deepbook.checkManagerBalance(balanceManagerKey, "DEEP")).balance,
        );
        filled = after - before;

        if (filled > 0) {
            console.log(`Order executed. Transaction digest: ${result.digest}`);
            console.log(`Filled ${filled} DEEP — BalanceManager went ${before} → ${after}.`);
            break;
        }

        console.log("Filled nothing: the ask side emptied between the check and the order.");
    }

    if (filled === 0) {
        console.error(`\nNo fill after ${MAX_ATTEMPTS} attempts.`);
        console.error("The market maker was not quoting asks for long enough to trade against.");
        console.error("Check it with: docker compose logs -f market-maker");
        process.exit(1);
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
});

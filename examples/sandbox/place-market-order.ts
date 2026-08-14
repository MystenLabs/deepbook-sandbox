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
 * The example waits for ask liquidity by itself.
 *
 * Usage: pnpm place-market-order
 */

import { SelfMatchingOptions } from "@mysten/deepbook-v3";
import { Transaction } from "@mysten/sui/transactions";
import { setupWithBalanceManager, signAndExecute, waitForLiquidity } from "./setup.js";

/** How many times to re-place the order if the ask side empties under us. */
const MAX_ATTEMPTS = 3;

/** Base quantity to buy, in DEEP. */
const QUANTITY = 10;

/** checkManagerBalance rounds to 9 decimals, so compare fills with a small tolerance. */
const EPSILON = 1e-9;

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
    // checkManagerBalance returns { coinType, balance } with balance in human units.
    const deepBalance = async () =>
        Number((await client.deepbook.checkManagerBalance(balanceManagerKey, "DEEP")).balance);

    let filled = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await waitForLiquidity(client, "DEEP_SUI", "ask");

        const before = await deepBalance();

        const orderTx = new Transaction();
        client.deepbook.deepBook.placeMarketOrder({
            poolKey: "DEEP_SUI",
            balanceManagerKey,
            clientOrderId: String(attempt),
            quantity: QUANTITY,
            isBid: true,
            selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
            payWithDeep: false,
        })(orderTx);

        console.log(`Placing market BUY: ${QUANTITY} DEEP (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const result = await signAndExecute(client, keypair, orderTx);

        const after = await deepBalance();
        filled = after - before;

        // Success means the whole order filled. A dust fill is not a demonstration
        // of a market order, so treat a partial fill as a retryable miss.
        if (filled >= QUANTITY - EPSILON) {
            console.log(`Order executed. Transaction digest: ${result.digest}`);
            console.log(`Filled ${filled} DEEP — BalanceManager went ${before} → ${after}.`);
            break;
        }

        console.log(
            `Filled ${filled} of ${QUANTITY} DEEP (digest ${result.digest}). Most likely the ` +
                "ask side thinned between the depth check and the order — inspect the digest " +
                "to confirm.",
        );
    }

    // Anything short of a full fill is a failure, including a negative or NaN delta.
    if (!(filled >= QUANTITY - EPSILON)) {
        console.error(`\nNo full fill after ${MAX_ATTEMPTS} attempts (last delta: ${filled}).`);
        console.error("The market maker was not quoting enough ask depth to trade against.");
        console.error("Check it with: docker compose logs -f market-maker");
        process.exit(1);
    }

    console.log("\nDone.");
}

main().catch((err) => {
    // Print the whole error, not just err.message: the setup helpers attach the
    // underlying failure as `cause`, and Node renders those chains natively.
    console.error(err);
    process.exit(1);
});

/**
 * Check Order Book — Read-only DeepBook SDK example
 *
 * Queries the DEEP/SUI pool for the current mid price and order book depth.
 * No wallet or signing required — demonstrates pure read-only SDK usage.
 *
 * A CLOB (Central Limit Order Book) matches buy orders (bids) with sell orders
 * (asks). The "mid price" is the midpoint between the best bid and best ask.
 *
 * Usage: pnpm check-order-book
 */

import { createReadOnlyClient, getMidPrice } from "./setup.js";

async function main() {
    const { client } = await createReadOnlyClient();

    // Read the depth first, so a genuinely empty book can be reported plainly.
    // Asking for the mid price first would abort on-chain and raise an opaque
    // SDK error before we ever got the chance to explain what is going on.
    //
    // Each tick contains a price and the total quantity resting at that level.
    const ticks = await client.deepbook.getLevel2TicksFromMid("DEEP_SUI", 5);

    if (ticks.ask_prices.length === 0 && ticks.bid_prices.length === 0) {
        console.log("Order book is empty — the market maker may still be starting up.");
        console.log("Wait 10-15 seconds after deploy-all completes and try again.");
        return;
    }

    // The mid price is the midpoint between best bid and best ask, and the most
    // common reference price for a pair. It only exists when both sides have
    // resting orders, so a one-sided book has no mid price to read — reporting
    // the depth we do have beats failing outright.
    //
    // getMidPrice retries across the market maker's rebalance window, when one
    // side of the book briefly disappears.
    const twoSided = ticks.ask_prices.length > 0 && ticks.bid_prices.length > 0;
    const midPrice = twoSided ? await getMidPrice(client, "DEEP_SUI") : null;

    if (midPrice === null) {
        const missing = ticks.ask_prices.length === 0 ? "ask" : "bid";
        console.log(`No ${missing} side resting — mid price unavailable.\n`);
    } else {
        console.log(`DEEP/SUI mid price: ${midPrice} SUI per DEEP\n`);
    }

    console.log("=== DEEP/SUI Order Book ===\n");

    // Format price with enough precision to distinguish levels.
    // DeepBook prices can be very small (e.g. 0.0000305), so fixed 4
    // decimals would truncate them all to 0.0000.
    const formatPrice = (n: number) => {
        if (n === 0) return "0";
        // Show up to 8 decimals, then strip trailing zeros
        return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    };

    // Ask side (sellers) — displayed top-down (highest first)
    const asks = ticks.ask_prices.map((price, i) => ({
        price: Number(price),
        quantity: Number(ticks.ask_quantities[i]),
    }));

    for (const level of asks.reverse()) {
        console.log(
            `  ASK  ${formatPrice(level.price).padStart(10)}  ${level.quantity.toFixed(2)} DEEP`,
        );
    }

    console.log(midPrice === null ? "  --- no mid ---" : `  --- mid: ${midPrice} ---`);

    // Bid side (buyers) — displayed top-down (highest first)
    const bids = ticks.bid_prices.map((price, i) => ({
        price: Number(price),
        quantity: Number(ticks.bid_quantities[i]),
    }));

    for (const level of bids) {
        console.log(
            `  BID  ${formatPrice(level.price).padStart(10)}  ${level.quantity.toFixed(2)} DEEP`,
        );
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
});

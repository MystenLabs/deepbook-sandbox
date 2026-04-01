/**
 * Swap Tokens — Direct wallet swap using DeepBook SDK
 *
 * Swaps SUI → DEEP on the DEEP/SUI pool without a BalanceManager.
 * This is the simplest trading interaction: coins go directly from
 * your wallet into the pool and back.
 *
 * The swap functions (swapExactQuoteForBase / swapExactBaseForQuote) are
 * distinct from market orders — they don't require a BalanceManager and
 * operate directly on wallet coins.
 *
 * Usage: pnpm swap-tokens
 */

import { Transaction } from "@mysten/sui/transactions";
import { setupSandbox, signAndExecute } from "./setup.js";

async function main() {
    const { client, keypair, address } = await setupSandbox();

    // Swap 0.1 SUI for DEEP on the DEEP/SUI pool.
    // Since SUI is the quote coin in DEEP/SUI, we use swapExactQuoteForBase.
    //
    // Parameters:
    //   amount:     Quote amount to spend (0.1 SUI)
    //   deepAmount: DEEP to pay as fee (0 for whitelisted pools)
    //   minOut:     Minimum base output (0 = no slippage protection, for demo only)
    const tx = new Transaction();
    const [baseCoin, quoteCoin, deepCoin] = tx.add(
        client.deepbook.deepBook.swapExactQuoteForBase({
            poolKey: "DEEP_SUI",
            amount: 0.1,
            deepAmount: 0,
            minOut: 0,
        }),
    );

    // The swap returns leftover coins that must be transferred back to the sender.
    // Without this, the coins would be destroyed at the end of the transaction.
    tx.transferObjects([baseCoin, quoteCoin, deepCoin], address);

    console.log("Executing swap: 0.1 SUI → DEEP...");
    const result = await signAndExecute(client, keypair, tx);
    console.log(`Transaction digest: ${result.digest}`);

    console.log("\nDone. Check explorer for detailed balance changes.");
}

main().catch((err) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
});

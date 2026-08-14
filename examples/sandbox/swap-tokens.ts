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
import { setupSandbox, signAndExecute, waitForLiquidity } from "./setup.js";

async function main() {
    const { client, keypair, address, manifest } = await setupSandbox();
    const deepType = manifest.pools.DEEP_SUI.baseCoinType;

    // A swap against an empty ask side matches nothing and STILL returns a
    // successful digest, exactly like a market order. Wait for depth first.
    await waitForLiquidity(client, "DEEP_SUI", "ask");

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

    // Read the fill from the transaction's OWN balance changes. Querying the node
    // for a balance afterwards is a separate, asynchronously-indexed read that can
    // still return the pre-swap figure, which would report a good swap as a failure.
    const received = (result.balanceChanges ?? [])
        .filter((c) => c.address === address && c.coinType === deepType)
        .reduce((sum, c) => sum + BigInt(c.amount), 0n);

    if (received <= 0n) {
        console.error("\nThe swap returned no DEEP, but the transaction succeeded.");
        console.error("minOut is 0, so an empty ask side makes this a silent no-op —");
        console.error("the ask side most likely emptied between the depth check and the swap.");
        console.error("Check the market maker with: docker compose logs -f market-maker");
        process.exit(1);
    }

    // DEEP has 6 decimals; divide for a human-readable figure.
    console.log(`Received ${Number(received) / 1_000_000} DEEP.`);
    console.log("\nDone.");
}

main().catch((err) => {
    // Print the whole error, not just err.message: the setup helpers attach the
    // underlying failure as `cause`, and Node renders those chains natively.
    console.error(err);
    process.exit(1);
});

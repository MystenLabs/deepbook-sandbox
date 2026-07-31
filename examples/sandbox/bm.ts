// examples/sandbox/bm.ts
// Shared BalanceManager creation (used by both localnet setup.ts and fork.ts).

import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import type { SandboxClient } from "./setup.js";

export async function createBalanceManager(
    client: SandboxClient,
    keypair: Ed25519Keypair,
): Promise<string> {
    const tx = new Transaction();
    client.deepbook.balanceManager.createAndShareBalanceManager()(tx);

    const result = await client.core.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        include: { effects: true, objectTypes: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(
            `BalanceManager creation failed: ${JSON.stringify(result.FailedTransaction)}`,
        );
    }

    const objectTypes = result.Transaction?.objectTypes ?? {};
    const balanceManagerId = result.Transaction?.effects?.changedObjects?.find(
        (obj) =>
            obj.idOperation === "Created" && objectTypes[obj.objectId]?.includes("BalanceManager"),
    )?.objectId;

    if (!balanceManagerId) {
        throw new Error("Failed to extract BalanceManager ID from transaction result");
    }

    // Wait for the gRPC node to index the shared BM before the next tx uses it.
    await client.core.waitForTransaction({ digest: result.Transaction!.digest });
    return balanceManagerId;
}

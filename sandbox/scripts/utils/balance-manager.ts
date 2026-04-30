import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

/**
 * Create a BalanceManager owned by `ownerAddress`, paid for by `payer`.
 *
 * Used by `deploy-all` to provision per-pool BMs for the market maker so the
 * MM container can restart without re-creating BMs (which used to drain the
 * MM wallet on every restart and produce one-sided liquidity).
 */
export async function createBalanceManagerForOwner(
    client: SuiGrpcClient,
    payer: Keypair,
    deepbookPackageId: string,
    ownerAddress: string,
): Promise<string> {
    const tx = new Transaction();
    const bm = tx.moveCall({
        target: `${deepbookPackageId}::balance_manager::new_with_custom_owner`,
        arguments: [tx.pure.address(ownerAddress)],
    });
    tx.transferObjects([bm], ownerAddress);

    const result = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: payer,
        include: { effects: true, objectTypes: true },
    });

    if (result.$kind === "FailedTransaction") {
        throw new Error(
            `createBalanceManagerForOwner failed: ${result.FailedTransaction.status.error || "unknown"}`,
        );
    }

    const txData = result.Transaction!;
    const objectTypes = txData.objectTypes ?? {};
    const created = (txData.effects?.changedObjects ?? []).find(
        (obj) =>
            obj.idOperation === "Created" &&
            (objectTypes[obj.objectId] ?? "").includes("::balance_manager::BalanceManager"),
    );
    if (!created) {
        throw new Error("BalanceManager object not found in transaction result");
    }
    return created.objectId;
}

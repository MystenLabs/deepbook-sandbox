import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

/** Simple lock to prevent concurrent signing (avoids object version conflicts). */
let signing = false;

export async function requestDeep(
    client: SuiGrpcClient,
    signer: Keypair,
    deepType: string,
    recipient: string,
    amount: number,
): Promise<{ success: boolean; digest?: string; error?: string }> {
    if (signing) {
        return { success: false, error: "Another DEEP request is in progress, try again shortly" };
    }

    signing = true;
    try {
        const tx = new Transaction();

        const coin = coinWithBalance({
            balance: amount,
            type: deepType,
            useGasCoin: false,
        })(tx);

        tx.transferObjects([coin], recipient);

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            include: { effects: true },
        });

        if (result.$kind === "FailedTransaction") {
            return {
                success: false,
                error: `Transaction failed: ${result.FailedTransaction.status.error ?? "unknown error"}`,
            };
        }

        const digest = result.Transaction!.digest;
        await client.waitForTransaction({ digest });

        return { success: true, digest };
    } finally {
        signing = false;
    }
}

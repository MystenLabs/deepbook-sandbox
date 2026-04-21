import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { tryAcquire, release } from "./signing-lock.js";

export async function requestUsdc(
    client: SuiGrpcClient,
    signer: Keypair,
    usdcType: string,
    recipient: string,
    amount: number,
): Promise<{ success: boolean; digest?: string; error?: string }> {
    if (!tryAcquire()) {
        return {
            success: false,
            error: "Another faucet request is in progress, try again shortly",
        };
    }

    try {
        const tx = new Transaction();

        const coin = coinWithBalance({
            balance: amount,
            type: usdcType,
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
        release();
    }
}

import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

// Serializes signing from the deployer wallet. Concurrent signs race on the
// deployer's gas coin / object versions, so all coin transfers share this lock.
let signing = false;

export async function requestCoin(
    client: SuiGrpcClient,
    signer: Keypair,
    coinType: string,
    recipient: string,
    amount: number,
): Promise<{ success: boolean; digest?: string; error?: string }> {
    if (signing) {
        return {
            success: false,
            error: "Another faucet request is in progress, try again shortly",
        };
    }

    signing = true;
    try {
        const tx = new Transaction();
        const coin = coinWithBalance({
            balance: amount,
            type: coinType,
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

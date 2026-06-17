import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

// Serializes signing from the deployer wallet. Concurrent signs race on the
// deployer's gas coin / object versions, so all coin transfers share this lock.
let signing = false;

// Distinguishes expected, recoverable conditions from genuine server faults so
// the route can map each to a meaningful HTTP status instead of a blanket 500:
//   - "busy"        — another request holds the signing lock; caller should retry
//   - "exhausted"   — the deployer's treasury for this coin is drained; needs a
//                     redeploy (`pnpm deploy-all`) to refill. This is what a
//                     long-running sandbox hits once the faucet supply runs out.
//   - "tx_failed"   — any other transaction/build failure (genuine error)
export type FaucetFailureKind = "busy" | "exhausted" | "tx_failed";

// Discriminated union on `success` so the invariants hold at the type level: a
// success carries a digest; a failure always carries a kind + error. This keeps
// the route from silently mapping an unclassified failure to a 500.
export type RequestCoinResult =
    | { success: true; digest: string }
    | { success: false; kind: FaucetFailureKind; error: string };

// `coinWithBalance` resolves the deployer's owned coins at build time, so an
// empty treasury surfaces as a thrown error rather than a FailedTransaction.
// Match the SDK's "Insufficient balance of <coin>…" build-time throw and the
// "No coins … found" shortage error.
export function isExhaustedError(message: string): boolean {
    return /insufficient\s+balance|no coins/i.test(message);
}

// A FailedTransaction's `status.error` is a structured ExecutionError (or a bare
// string); flatten it to a human-readable line for matching and reporting.
export function stringifyExecutionError(error: unknown): string {
    if (error == null) return "unknown error";
    if (typeof error === "string") return error;
    if (typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message;
    }
    return JSON.stringify(error);
}

// Both failure branches (a FailedTransaction and a thrown build error) classify
// the same way: exhausted treasury vs. any other fault.
export function classifyFailure(message: string): RequestCoinResult {
    return {
        success: false,
        kind: isExhaustedError(message) ? "exhausted" : "tx_failed",
        error: message,
    };
}

export async function requestCoin(
    client: SuiGrpcClient,
    signer: Keypair,
    coinType: string,
    recipient: string,
    amount: number,
): Promise<RequestCoinResult> {
    if (signing) {
        return {
            success: false,
            kind: "busy",
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
            const reason = stringifyExecutionError(result.FailedTransaction.status.error);
            return classifyFailure(`Transaction failed: ${reason}`);
        }

        const digest = result.Transaction!.digest;
        await client.waitForTransaction({ digest });
        return { success: true, digest };
    } catch (err) {
        // Build/execution threw (e.g. coinWithBalance found no coins to source).
        return classifyFailure(err instanceof Error ? err.message : String(err));
    } finally {
        signing = false;
    }
}

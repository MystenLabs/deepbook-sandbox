import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import type { Keypair } from "@mysten/sui/cryptography";
import type { DeploymentResult } from "./deployer";
import log from "./logger";

export type DeploymentEnvOptions = { firstCheckpoint?: string };

const ONE_SUI_MIST = BigInt(1_000_000_000);

/** Request from faucet with retries (helps with localnet ECONNRESET until faucet is stable). */
export async function requestFaucetWithRetry(
    host: string,
    recipient: string,
    maxRetries = 3,
): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await requestSuiFromFaucetV2({ host, recipient });
            return;
        } catch (error) {
            if (attempt === maxRetries) break;
            const delay = 3000 * attempt;
            log.warn(`Faucet attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    throw new Error(
        `Faucet failed after ${maxRetries} retries and recipient balance is below 1 SUI. Cannot continue.`,
    );
}

/** Check balance first; only request faucet if below min. If we request and faucet fails, throw. */
export async function ensureMinimumBalance(
    client: SuiGrpcClient,
    recipient: string,
    faucetHost: string,
    minSuiMist: bigint = ONE_SUI_MIST,
    maxFaucetRetries = 3,
): Promise<void> {
    const { balance } = await client.getBalance({ owner: recipient });
    const balanceMist = BigInt(balance.balance);
    if (balanceMist >= minSuiMist) {
        log.success("Has sufficient balance (>= 1 SUI)");
        return;
    }
    await requestFaucetWithRetry(faucetHost, recipient, maxFaucetRetries);
    await new Promise((r) => setTimeout(r, 2000));
    const after = await client.getBalance({ owner: recipient });
    log.success(`Has ${after.balance.balance} MIST balance`);
}

/**
 * Hit the localnet faucet in a loop until the recipient holds at least
 * `targetMist` of SUI. Each faucet call yields ~1000 SUI; use this when you
 * need more than a single call can provide (e.g. funding the MM with
 * thousands of SUI for scaled-up BM deposits).
 */
export async function ensureSuiBalanceAtLeast(
    client: SuiGrpcClient,
    recipient: string,
    faucetHost: string,
    targetMist: bigint,
    maxCalls = 10,
): Promise<void> {
    for (let i = 0; i < maxCalls; i++) {
        const { balance } = await client.getBalance({ owner: recipient });
        if (BigInt(balance.balance) >= targetMist) {
            log.success(`Has ${balance.balance} MIST balance (target ${targetMist})`);
            return;
        }
        await requestFaucetWithRetry(faucetHost, recipient, 3);
        await new Promise((r) => setTimeout(r, 2000));
    }
    const final = await client.getBalance({ owner: recipient });
    if (BigInt(final.balance.balance) < targetMist) {
        log.warn(
            `Faucet loop ended with ${final.balance.balance} MIST (target ${targetMist}). Continuing anyway.`,
        );
    } else {
        log.success(`Has ${final.balance.balance} MIST balance (target ${targetMist})`);
    }
}

/**
 * Build env vars for indexer/server from deployment results. All IDs come from the
 * deployment map.
 */
export function getDeploymentEnv(
    deployedPackages: Map<string, DeploymentResult>,
    options?: DeploymentEnvOptions,
): Record<string, string> {
    const token = deployedPackages.get("token");
    const deepbook = deployedPackages.get("deepbook");
    const margin = deployedPackages.get("deepbook_margin");

    const treasuryObj = token.createdObjects.find((obj) =>
        obj.objectType.includes("ProtectedTreasury"),
    );
    const deepTreasuryId = treasuryObj?.objectId ?? "";

    const env: Record<string, string> = {
        DEEPBOOK_PACKAGE_ID: deepbook.packageId,
        DEEP_TOKEN_PACKAGE_ID: token.packageId,
        DEEP_TREASURY_ID: deepTreasuryId,
        DEEPBOOK_MARGIN_PACKAGE_ID: margin.packageId,
    };
    if (options.firstCheckpoint) env.FIRST_CHECKPOINT = options.firstCheckpoint;
    return env;
}

export interface TransferCoinOptions {
    client: SuiGrpcClient;
    signer: Keypair;
    coinType: string;
    amount: bigint | number;
    recipient: string;
    /** Short label for log lines (e.g. "DEEP", "USDC"). Defaults to coinType. */
    label?: string;
}

/**
 * Transfer a fixed amount of a coin from `signer` to `recipient`. Splits a
 * fresh coin via `coinWithBalance` (does not consume the gas coin). On
 * failure logs a warning and returns false rather than throwing — preserves
 * the existing best-effort semantics in deploy-all.
 */
export async function transferCoin({
    client,
    signer,
    coinType,
    amount,
    recipient,
    label,
}: TransferCoinOptions): Promise<boolean> {
    const tag = label ?? coinType;
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
        log.warn(`Failed to transfer ${tag} to ${recipient}`);
        return false;
    }
    await client.waitForTransaction({ digest: result.Transaction!.digest });
    log.success(`Transferred ${amount} ${tag} to ${recipient}`);
    return true;
}

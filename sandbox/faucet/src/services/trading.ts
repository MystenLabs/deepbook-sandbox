/**
 * Server-side trading service using the @mysten/deepbook-v3 SDK.
 *
 * Signs transactions with the deployer key — no wallet extension needed.
 * The SDK handles decimal conversion, coin management, and proof generation.
 */

import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import type { SandboxClient } from "./deepbook-client.js";
import { BALANCE_MANAGER_KEY, getCoinScalar } from "./deepbook-client.js";

/* ------------------------------------------------------------------ */
/*  Concurrency lock (same pattern as deep-faucet.ts)                  */
/* ------------------------------------------------------------------ */

let signing = false;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (signing) throw new Error("Another transaction is in progress, try again");
    signing = true;
    try {
        return await fn();
    } finally {
        signing = false;
    }
}

/* ------------------------------------------------------------------ */
/*  Sign + execute helper                                              */
/* ------------------------------------------------------------------ */

async function signAndExec(client: SandboxClient, signer: Keypair, tx: Transaction) {
    const result = await client.core.signAndExecuteTransaction({
        transaction: tx,
        signer,
        include: {
            effects: true as const,
            objectTypes: true as const,
        },
    });

    if (result.$kind === "FailedTransaction") {
        const err = result.FailedTransaction.status.error;
        throw new Error(err ? err.message : "Transaction failed");
    }

    const digest = result.Transaction!.digest;
    await client.core.waitForTransaction({ digest });

    return result.Transaction!;
}

/* ------------------------------------------------------------------ */
/*  Balance Manager                                                    */
/* ------------------------------------------------------------------ */

export async function createBalanceManager(
    client: SandboxClient,
    signer: Keypair,
): Promise<{ balanceManagerId: string; digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.balanceManager.createAndShareBalanceManager()(tx);

        const txResult = await signAndExec(client, signer, tx);

        const objectTypes = txResult.objectTypes ?? {};
        const changedObjects = txResult.effects!.changedObjects;

        const bmCreated = changedObjects.find(
            (obj) =>
                obj.idOperation === "Created" &&
                obj.outputState !== "PackageWrite" &&
                (objectTypes[obj.objectId] ?? "").includes("::balance_manager::BalanceManager"),
        );

        if (!bmCreated) throw new Error("BalanceManager not found in transaction result");

        return { balanceManagerId: bmCreated.objectId, digest: txResult.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Deposit / Withdraw                                                 */
/* ------------------------------------------------------------------ */

export async function deposit(
    client: SandboxClient,
    signer: Keypair,
    coinKey: string,
    amount: number,
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.balanceManager.depositIntoManager(BALANCE_MANAGER_KEY, coinKey, amount)(tx);

        const txResult = await signAndExec(client, signer, tx);
        return { digest: txResult.digest };
    });
}

export async function withdraw(
    client: SandboxClient,
    signer: Keypair,
    coinKey: string,
    amount: number,
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.balanceManager.withdrawFromManager(
            BALANCE_MANAGER_KEY,
            coinKey,
            amount,
            signer.getPublicKey().toSuiAddress(),
        )(tx);

        const txResult = await signAndExec(client, signer, tx);
        return { digest: txResult.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Order placement                                                    */
/* ------------------------------------------------------------------ */

export async function placeLimitOrder(
    client: SandboxClient,
    signer: Keypair,
    params: {
        poolKey: string;
        price: number;
        quantity: number;
        isBid: boolean;
    },
): Promise<{ digest: string; orderId: string | null }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.deepBook.placeLimitOrder({
            poolKey: params.poolKey,
            balanceManagerKey: BALANCE_MANAGER_KEY,
            clientOrderId: String(Date.now()),
            price: params.price,
            quantity: params.quantity,
            isBid: params.isBid,
            orderType: OrderType.NO_RESTRICTION,
            selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
            payWithDeep: false,
        })(tx);

        const txResult = await signAndExec(client, signer, tx);
        return { digest: txResult.digest, orderId: null };
    });
}

export async function placeMarketOrder(
    client: SandboxClient,
    signer: Keypair,
    params: {
        poolKey: string;
        quantity: number;
        isBid: boolean;
    },
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.deepBook.placeMarketOrder({
            poolKey: params.poolKey,
            balanceManagerKey: BALANCE_MANAGER_KEY,
            clientOrderId: String(Date.now()),
            quantity: params.quantity,
            isBid: params.isBid,
            selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
            payWithDeep: false,
        })(tx);

        const txResult = await signAndExec(client, signer, tx);
        return { digest: txResult.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Cancel                                                             */
/* ------------------------------------------------------------------ */

export async function cancelOrder(
    client: SandboxClient,
    signer: Keypair,
    poolKey: string,
    orderId: string,
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.deepBook.cancelOrder(poolKey, BALANCE_MANAGER_KEY, orderId)(tx);

        const txResult = await signAndExec(client, signer, tx);
        return { digest: txResult.digest };
    });
}

export async function cancelAllOrders(
    client: SandboxClient,
    signer: Keypair,
    poolKey: string,
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();
        client.deepbook.deepBook.cancelAllOrders(poolKey, BALANCE_MANAGER_KEY)(tx);

        const txResult = await signAndExec(client, signer, tx);
        return { digest: txResult.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Read-only queries (no signing, no lock)                            */
/* ------------------------------------------------------------------ */

export async function getBalance(
    client: SandboxClient,
    signer: Keypair,
    coinKey: string,
): Promise<number> {
    try {
        // SDK's checkManagerBalance works for shared BalanceManagers
        const { balance } = await client.deepbook.checkManagerBalance(BALANCE_MANAGER_KEY, coinKey);
        return balance;
    } catch {
        // Fallback: set sender explicitly for owned BalanceManagers
        return getBalanceWithSender(client, signer, coinKey);
    }
}

async function getBalanceWithSender(
    client: SandboxClient,
    signer: Keypair,
    coinKey: string,
): Promise<number> {
    const tx = new Transaction();
    tx.setSender(signer.getPublicKey().toSuiAddress());

    // Use the SDK to build the balance query move call
    client.deepbook.balanceManager.checkManagerBalance(BALANCE_MANAGER_KEY, coinKey)(tx);

    const result = await client.core.simulateTransaction({
        transaction: tx,
        include: { effects: true, commandResults: true },
    });

    if (result.$kind === "FailedTransaction") return 0;

    const returnValues = result.commandResults?.[0]?.returnValues;
    if (!returnValues || returnValues.length === 0) return 0;

    const bytes = returnValues[0].bcs;
    // Parse u64 little-endian
    let value = 0n;
    for (let i = 0; i < 8; i++) {
        value |= BigInt(bytes[i]) << BigInt(i * 8);
    }

    const scalar = getCoinScalar(coinKey);
    return Number(value) / scalar;
}

export async function getOpenOrders(client: SandboxClient, poolKey: string) {
    try {
        const raw = await client.deepbook.getAccountOrderDetails(poolKey, BALANCE_MANAGER_KEY);

        // Enrich with is_bid and price by decoding the on-chain order ID
        return raw.map((order) => {
            try {
                const decoded = client.deepbook.decodeOrderId(BigInt(order.order_id));
                return {
                    ...order,
                    is_bid: decoded.isBid,
                    price: String(decoded.price),
                };
            } catch {
                return order;
            }
        });
    } catch {
        // Fallback for owned BMs: SDK doesn't set sender for simulate.
        return [];
    }
}

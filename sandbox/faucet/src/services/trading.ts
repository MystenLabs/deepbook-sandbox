/**
 * Server-side trading service.
 *
 * Signs transactions with the deployer key — no wallet extension needed.
 * Adapts patterns from sandbox/scripts/market-maker/balance-manager.ts
 * and sandbox/scripts/market-maker/order-manager.ts.
 */

import type { SuiClient, SuiObjectChangeCreated, SuiEvent } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

const SUI_CLOCK_OBJECT_ID = "0x6";

const ORDER_TYPE = {
    NO_RESTRICTION: 0,
    IMMEDIATE_OR_CANCEL: 1,
    FILL_OR_KILL: 2,
    POST_ONLY: 3,
} as const;

const SELF_MATCHING = {
    ALLOWED: 0,
    CANCEL_TAKER: 1,
    CANCEL_MAKER: 2,
} as const;

// Simple concurrency lock (same pattern as deep-faucet.ts)
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
/*  Balance Manager                                                    */
/* ------------------------------------------------------------------ */

export async function createBalanceManager(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
): Promise<{ balanceManagerId: string; digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();

        const bm = tx.moveCall({
            target: `${packageId}::balance_manager::new`,
            arguments: [],
        });

        tx.transferObjects([bm], signer.getPublicKey().toSuiAddress());

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true, showObjectChanges: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Transaction failed");
        }

        await client.waitForTransaction({ digest: result.digest });

        const bmCreated = result.objectChanges?.find(
            (obj): obj is SuiObjectChangeCreated =>
                obj.type === "created" &&
                obj.objectType.includes("::balance_manager::BalanceManager"),
        );

        if (!bmCreated) throw new Error("BalanceManager not found in transaction result");

        return { balanceManagerId: bmCreated.objectId, digest: result.digest };
    });
}

export async function deposit(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    balanceManagerId: string,
    coinType: string,
    amount: bigint,
): Promise<{ digest: string }> {
    return withLock(async () => {
        const signerAddress = signer.getPublicKey().toSuiAddress();
        const isSui = coinType === "0x2::sui::SUI";

        const tx = new Transaction();

        let coinToDeposit;
        if (isSui) {
            coinToDeposit = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
        } else {
            const coins = await client.getCoins({ owner: signerAddress, coinType });
            if (coins.data.length === 0) throw new Error(`No ${coinType} coins available`);

            const coinIds = coins.data.map((c) => c.coinObjectId);
            if (coinIds.length === 1) {
                coinToDeposit = tx.splitCoins(tx.object(coinIds[0]), [tx.pure.u64(amount)]);
            } else {
                const [first, ...rest] = coinIds;
                const primaryCoin = tx.object(first);
                if (rest.length > 0) {
                    tx.mergeCoins(
                        primaryCoin,
                        rest.map((id) => tx.object(id)),
                    );
                }
                coinToDeposit = tx.splitCoins(primaryCoin, [tx.pure.u64(amount)]);
            }
        }

        tx.moveCall({
            target: `${packageId}::balance_manager::deposit`,
            typeArguments: [coinType],
            arguments: [tx.object(balanceManagerId), coinToDeposit],
        });

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Deposit failed");
        }

        await client.waitForTransaction({ digest: result.digest });
        return { digest: result.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Order placement                                                    */
/* ------------------------------------------------------------------ */

export async function placeLimitOrder(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    params: {
        poolId: string;
        balanceManagerId: string;
        baseType: string;
        quoteType: string;
        price: bigint;
        quantity: bigint;
        isBid: boolean;
    },
): Promise<{ digest: string; orderId: string | null }> {
    return withLock(async () => {
        const tx = new Transaction();

        const tradeProof = tx.moveCall({
            target: `${packageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(params.balanceManagerId)],
        });

        const expireTimestamp = BigInt("18446744073709551615");
        const clientOrderId = BigInt(Date.now());

        tx.moveCall({
            target: `${packageId}::pool::place_limit_order`,
            typeArguments: [params.baseType, params.quoteType],
            arguments: [
                tx.object(params.poolId),
                tx.object(params.balanceManagerId),
                tradeProof,
                tx.pure.u64(clientOrderId),
                tx.pure.u8(ORDER_TYPE.NO_RESTRICTION),
                tx.pure.u8(SELF_MATCHING.ALLOWED),
                tx.pure.u64(params.price),
                tx.pure.u64(params.quantity),
                tx.pure.bool(params.isBid),
                tx.pure.bool(false), // pay_with_deep
                tx.pure.u64(expireTimestamp),
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true, showEvents: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Order placement failed");
        }

        await client.waitForTransaction({ digest: result.digest });

        const orderId = extractOrderIdFromEvent(
            (result.events || []).find((e) => e.type.includes("::OrderPlaced")),
        );

        return { digest: result.digest, orderId };
    });
}

export async function placeMarketOrder(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    params: {
        poolId: string;
        balanceManagerId: string;
        baseType: string;
        quoteType: string;
        quantity: bigint;
        isBid: boolean;
    },
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();

        const tradeProof = tx.moveCall({
            target: `${packageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(params.balanceManagerId)],
        });

        const clientOrderId = BigInt(Date.now());

        tx.moveCall({
            target: `${packageId}::pool::place_market_order`,
            typeArguments: [params.baseType, params.quoteType],
            arguments: [
                tx.object(params.poolId),
                tx.object(params.balanceManagerId),
                tradeProof,
                tx.pure.u64(clientOrderId),
                tx.pure.u8(SELF_MATCHING.ALLOWED),
                tx.pure.u64(params.quantity),
                tx.pure.bool(params.isBid),
                tx.pure.bool(false), // pay_with_deep
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Market order failed");
        }

        await client.waitForTransaction({ digest: result.digest });
        return { digest: result.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Cancel                                                             */
/* ------------------------------------------------------------------ */

export async function cancelOrder(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    params: {
        poolId: string;
        balanceManagerId: string;
        baseType: string;
        quoteType: string;
        orderId: string;
    },
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();

        const tradeProof = tx.moveCall({
            target: `${packageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(params.balanceManagerId)],
        });

        tx.moveCall({
            target: `${packageId}::pool::cancel_order`,
            typeArguments: [params.baseType, params.quoteType],
            arguments: [
                tx.object(params.poolId),
                tx.object(params.balanceManagerId),
                tradeProof,
                tx.pure.u128(params.orderId),
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Cancel failed");
        }

        await client.waitForTransaction({ digest: result.digest });
        return { digest: result.digest };
    });
}

export async function cancelAllOrders(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    params: {
        poolId: string;
        balanceManagerId: string;
        baseType: string;
        quoteType: string;
    },
): Promise<{ digest: string }> {
    return withLock(async () => {
        const tx = new Transaction();

        const tradeProof = tx.moveCall({
            target: `${packageId}::balance_manager::generate_proof_as_owner`,
            arguments: [tx.object(params.balanceManagerId)],
        });

        tx.moveCall({
            target: `${packageId}::pool::cancel_all_orders`,
            typeArguments: [params.baseType, params.quoteType],
            arguments: [
                tx.object(params.poolId),
                tx.object(params.balanceManagerId),
                tradeProof,
                tx.object(SUI_CLOCK_OBJECT_ID),
            ],
        });

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Cancel all failed");
        }

        await client.waitForTransaction({ digest: result.digest });
        return { digest: result.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Withdraw                                                           */
/* ------------------------------------------------------------------ */

export async function withdraw(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    balanceManagerId: string,
    coinType: string,
    amount: bigint,
): Promise<{ digest: string }> {
    return withLock(async () => {
        const signerAddress = signer.getPublicKey().toSuiAddress();
        const tx = new Transaction();

        const coin = tx.moveCall({
            target: `${packageId}::balance_manager::withdraw`,
            typeArguments: [coinType],
            arguments: [tx.object(balanceManagerId), tx.pure.u64(amount)],
        });

        tx.transferObjects([coin], signerAddress);

        const result = await client.signAndExecuteTransaction({
            transaction: tx,
            signer,
            options: { showEffects: true },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(result.effects?.status.error || "Withdraw failed");
        }

        await client.waitForTransaction({ digest: result.digest });
        return { digest: result.digest };
    });
}

/* ------------------------------------------------------------------ */
/*  Balance query (read-only, no signing needed)                       */
/* ------------------------------------------------------------------ */

export async function getBalance(
    client: SuiClient,
    signer: Keypair,
    packageId: string,
    balanceManagerId: string,
    coinType: string,
): Promise<bigint> {
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::balance_manager::balance`,
        typeArguments: [coinType],
        arguments: [tx.object(balanceManagerId)],
    });

    const result = await client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: signer.getPublicKey().toSuiAddress(),
    });

    if (result.effects.status.status !== "success") return 0n;

    const returnValues = result.results?.[0]?.returnValues;
    if (!returnValues || returnValues.length === 0) return 0n;

    const [bytes] = returnValues[0];
    let value = 0n;
    for (let i = 0; i < 8; i++) {
        value |= BigInt(bytes[i]) << BigInt(i * 8);
    }
    return value;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractOrderIdFromEvent(event: SuiEvent | undefined): string | null {
    if (!event) return null;
    const parsedJson = event.parsedJson as Record<string, unknown> | undefined;
    if (!parsedJson) return null;

    for (const field of ["order_id", "orderId", "id"]) {
        if (field in parsedJson) {
            const value = parsedJson[field];
            if (typeof value === "string") return value;
            if (typeof value === "bigint" || typeof value === "number") return String(value);
        }
    }
    return null;
}

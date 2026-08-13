// Shared SUI grant for the fork stack members (SEDEFI-456).
//
// devstack's fork SUI faucet strategy is STRUCTURALLY disabled on this stack:
// `selectSufficientForkCoin` vets the faucet whale via `listCoins`, which is
// index-backed and returns empty on a fork — so `fundingFaucetStrategy`
// resolves to null and every faucet-based SUI path silently has no provider.
// (Recorded with the other devstack asks; also why trade-sim's gas refills
// never fire.)
//
// The working SUI source on the fork is the same one DEEP funding uses: the
// impersonated mainnet whale's KNOWN SUI coin (deployments/
// fork-impersonation.md; env-overridable ids shared with deep-funding.ts).
// This module grants SUI by splitting from that coin with an empty-signature
// impersonated tx built from concrete refs (no simulation on the fork).
//
// Grants are serialized through a module-level chain: concurrent grants would
// race on the whale coin's version and revert.

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";

const WHALE =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const WHALE_GAS_COIN =
    process.env.SUI_GAS_COIN_ID?.trim() ||
    "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714";

const GAS_BUDGET = 50_000_000n; // 0.05 SUI — the whale's pinned coin is small
const GAS_PRICE = 1_000n;

/** The FULL gRPC core surface (deps.sui.sdk.client.core — NOT the narrow
 *  sdk.core shim, which lacks listOwnedObjects and friends). */
export type FullCore = {
    getObject: (args: { objectId: string; include?: { content?: boolean } }) => Promise<{
        object?: {
            objectId: string;
            version: string;
            digest: string;
            type?: string;
            content?: Uint8Array;
        };
    }>;
    listOwnedObjects: (args: {
        owner: string;
    }) => Promise<{ objects?: { objectId: string; type?: string }[] }>;
    executeTransaction: (args: {
        transaction: Uint8Array;
        signatures: readonly string[];
        include?: { effects?: boolean; objectTypes?: boolean };
    }) => Promise<unknown>;
};

/** Coin<T> balance from BCS content: u64 LE right after the 32-byte UID. */
export const coinBalanceFromContent = (content: Uint8Array | undefined): bigint => {
    if (!content || content.length < 40) return 0n;
    return new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true);
};

const executionFailed = (raw: unknown): string | null => {
    type Status = { success?: boolean; error?: unknown };
    type Tx = { status?: Status; effects?: { status?: Status } };
    const r = raw as { $kind?: string; Transaction?: Tx; FailedTransaction?: Tx };
    const status =
        r?.FailedTransaction?.status ??
        r?.FailedTransaction?.effects?.status ??
        r?.Transaction?.status ??
        r?.Transaction?.effects?.status;
    if (r?.$kind === "FailedTransaction" || status?.success === false) {
        return JSON.stringify(status?.error ?? status ?? "FailedTransaction").slice(0, 300);
    }
    return null;
};

/** Serialize grants — concurrent whale-coin spends revert on version. */
let grantChain: Promise<unknown> = Promise.resolve();

/** In-module serialization can't cover OTHER whale spenders (trade-sim's
 *  boot txs use the same coin), so version conflicts retry with a freshly
 *  resolved ref. */
const GRANT_ATTEMPTS = 3;
const GRANT_RETRY_MS = 2_000;

/**
 * Transfer `amountMist` SUI from the impersonated whale to `recipient`.
 * Throws with a pointed message when the whale coin can't cover it — the
 * pinned coin is small (fractions of a SUI); grants should be sized in the
 * 0.1–0.2 SUI range and callers should treat failure as non-fatal where the
 * stack can still be useful without the grant.
 */
export function suiGrantViaWhale(
    core: FullCore,
    recipient: string,
    amountMist: bigint,
): Promise<void> {
    const run = async (): Promise<void> => {
        const res = await core.getObject({
            objectId: WHALE_GAS_COIN,
            include: { content: true },
        });
        const coin = res.object;
        if (!coin) {
            throw new Error(
                `whale SUI coin ${WHALE_GAS_COIN} not found on the fork ` +
                    "(spent? refresh via 'node scripts/refresh-donor-coins.mjs' / SUI_GAS_COIN_ID)",
            );
        }
        const balance = coinBalanceFromContent(coin.content);
        if (balance < amountMist + GAS_BUDGET) {
            throw new Error(
                `whale SUI coin holds ${balance} MIST — cannot grant ${amountMist} ` +
                    `plus ${GAS_BUDGET} budget (fork SUI is scarce; see fork-impersonation.md)`,
            );
        }
        const tx = new Transaction();
        const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
        tx.transferObjects([chunk], recipient);
        tx.setSender(WHALE);
        tx.setGasBudget(GAS_BUDGET);
        tx.setGasPrice(GAS_PRICE);
        tx.setGasOwner(WHALE);
        tx.setGasPayment([
            { objectId: coin.objectId, version: String(coin.version), digest: coin.digest },
        ]);
        tx.setExpiration({ None: true });
        await tx.prepareForSerialization({});
        for (const input of tx.getData().inputs) {
            if ((input as { UnresolvedObject?: unknown }).UnresolvedObject !== undefined) {
                throw new Error("sui grant built an unresolved input — concrete refs only");
            }
        }
        const bytes = TransactionDataBuilder.restore(tx.getData()).build();
        const raw = await core.executeTransaction({
            transaction: bytes,
            signatures: [],
            include: { effects: true },
        });
        const failure = executionFailed(raw);
        if (failure !== null) throw new Error(`sui grant reverted: ${failure}`);
    };
    const runWithRetry = async (): Promise<void> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= GRANT_ATTEMPTS; attempt++) {
            try {
                return await run();
            } catch (cause) {
                lastError = cause;
                if (attempt < GRANT_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, GRANT_RETRY_MS));
                }
            }
        }
        throw lastError;
    };
    const next = grantChain.then(runWithRetry, runWithRetry);
    grantChain = next.catch(() => undefined);
    return next;
}

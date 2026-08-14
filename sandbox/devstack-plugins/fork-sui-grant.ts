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

// SUI comes from a DIFFERENT donor than DEEP. The DEEP whale holds a single
// SUI coin worth ~0.7 SUI at the pinned checkpoint — enough for gas, nowhere
// near enough to hand out, which is why grants used to be capped at 0.1 SUI
// and started failing outright once boot funding drained it. The deepbook
// adminWallet (already impersonated by registry-init) holds ~9.5k SUI across
// 8 coins on mainnet, and its largest is present at the pin with the same
// balance — verified live 2026-08-14:
//   0xd99d6529…6f67  5493.977504296 SUI (mainnet == fork)
// Override either half with SUI_DONOR_ADDRESS / SUI_DONOR_COIN_ID; refresh a
// stale id with `node scripts/refresh-donor-coins.mjs`.
const SUI_DONOR =
    process.env.SUI_DONOR_ADDRESS ??
    "0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e";
const SUI_DONOR_COIN =
    process.env.SUI_DONOR_COIN_ID?.trim() ||
    "0xd99d6529c67e2330a856e98c141ff57bc8069e36646523ad2f3981cdec8b6f67";

const GAS_BUDGET = 50_000_000n; // 0.05 SUI — a split+transfer costs ~2M
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

/** Floor below which a funding tx cannot pay for itself; the observed cost of
 *  these grants is ~2-6M MIST, so this leaves ample headroom. */
export const MIN_FORK_GAS_BUDGET = 20_000_000n; // 0.02 SUI

/**
 * Cap a fork gas budget to what the payment coin actually holds.
 *
 * Sui rejects any transaction whose gas coin holds less than the DECLARED
 * budget, before execution ("Balance of gas object N is lower than the needed
 * amount"). The whale's pinned SUI coin is small (~0.25 SUI at the pin) and
 * boot funding spends most of it on the dev wallet's SUI grant, so a fixed
 * 0.1 SUI budget breaks every later grant — including DEEP and USDC, which
 * pay gas from the same coin. Worse, that rejection surfaces as a THROWN
 * executeTransaction error, which the funding plugins label "(transport)",
 * making a fully-diagnosable balance problem look like an unreachable fork.
 */
export async function cappedForkGasBudget(
    core: Pick<FullCore, "getObject">,
    gasCoinId: string,
    ceiling: bigint,
): Promise<bigint> {
    const res = await core.getObject({ objectId: gasCoinId, include: { content: true } });
    const balance = coinBalanceFromContent(res.object?.content);
    if (balance < MIN_FORK_GAS_BUDGET) {
        throw new Error(
            `fork gas coin ${gasCoinId} holds ${balance} MIST, below the ${MIN_FORK_GAS_BUDGET} ` +
                `minimum budget — refresh the donor coin (fork SUI is scarce; see ` +
                `deployments/fork-impersonation.md)`,
        );
    }
    return balance < ceiling ? balance : ceiling;
}

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
 * Transfer `amountMist` SUI from the impersonated SUI donor to `recipient`.
 * Throws with a pointed message when the donor coin can't cover it; callers
 * should treat failure as non-fatal where the stack is still useful without
 * the grant.
 */
export function suiGrantViaWhale(
    core: FullCore,
    recipient: string,
    amountMist: bigint,
): Promise<void> {
    const run = async (): Promise<void> => {
        const res = await core.getObject({
            objectId: SUI_DONOR_COIN,
            include: { content: true },
        });
        const coin = res.object;
        if (!coin) {
            throw new Error(
                `SUI donor coin ${SUI_DONOR_COIN} not found on the fork ` +
                    "(spent? refresh via 'node scripts/refresh-donor-coins.mjs' / SUI_DONOR_COIN_ID)",
            );
        }
        const balance = coinBalanceFromContent(coin.content);
        if (balance < amountMist + GAS_BUDGET) {
            throw new Error(
                `SUI donor coin holds ${balance} MIST — cannot grant ${amountMist} ` +
                    `plus ${GAS_BUDGET} budget (see deployments/fork-impersonation.md)`,
            );
        }
        const tx = new Transaction();
        const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
        tx.transferObjects([chunk], recipient);
        tx.setSender(SUI_DONOR);
        tx.setGasBudget(GAS_BUDGET);
        tx.setGasPrice(GAS_PRICE);
        tx.setGasOwner(SUI_DONOR);
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

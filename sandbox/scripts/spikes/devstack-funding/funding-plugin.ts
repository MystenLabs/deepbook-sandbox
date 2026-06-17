// Devstack funding-strategy spike — custom non-SUI coinType funding strategy plugin.
//
// The load-bearing finding (two parts):
//
//  1. CONTRIBUTION. `defineFaucetStrategy` is SUI-only, so a non-SUI coin
//     funding strategy is contributed via the generic `strategyContributor`
//     under a `coinType:<fullCoinType>` capability key, wrapping an
//     `AccountFundingStrategy`. This is the exact shape the DEEP funding-strategy
//     plugin and the USDC funding-strategy plugin will follow — only the
//     `request` body differs.
//
//  2. BODY. On a forked mainnet the body CANNOT sign (the impersonated whale
//     has no key) and CANNOT let the SDK auto-select gas. devstack's own fork
//     faucet solves this with internal primitives that are NOT exported from
//     the package root (dist/plugins/sui/fork-transaction.mjs +
//     fork-faucet-strategy.mjs). A custom plugin REACHES the fork admin surface
//     + sdk client through the public `sui` plugin VALUE (`deps.sui.fork`,
//     `deps.sui.sdk.core`), but must RE-IMPLEMENT the build helper. We do, using
//     only the public `@mysten/sui` surface.
//
//  A hard sui-fork constraint shapes the body (verified the hard way — it aborts
//  the fork with SIGABRT, taking the whole stack down). DEEP and USDC ARE
//  migrated into the on-chain CoinRegistry (their shared `Currency<T>` objects
//  exist on mainnet), but the fork can't use them: `StateService.GetCoinInfo`
//  is registry-first, and its INTERNAL `object_store.get_object(currencyId)`
//  doesn't lazy-fetch the shared Currency on the fork → misses the registry →
//  falls to `RpcIndexes::get_coin_info`, which is `todo!("not supported yet")`
//  (crates/sui-fork/src/store.rs, still on main 2026-06-13) → the fork process
//  aborts. The @mysten/sui client invokes GetCoinInfo whenever it enriches a
//  coin transfer's balance-changes, so executing the DEEP transfer trips it
//  REGARDLESS of execute `include` flags. We minimize abort surface by building
//  the PTB OFFLINE with concrete {objectId, version, digest} refs (no getObject
//  — getObject on a coin-typed object trips the same GetCoinInfo) and executing
//  empty-sig via `core.executeTransaction`. But the execute's own enrichment
//  still needs the fork not to panic, so a STOCK fork can't complete it; see
//  SUI-FORK-NOTES.md. Validated with `.fork-patched/` (get_coin_info -> Ok(None)).
//  Seeding the Currency does NOT help (sui-fork's --object refuses shared
//  objects); priming it via getObject self-aborts (chicken-and-egg).

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { Effect } from "effect";
import {
    definePlugin,
    strategyContributor,
    sui,
    type AccountFundingStrategy,
} from "@mysten-incubation/devstack";

// Any non-SUI fullCoinType funds the same way. Default: mainnet DEEP.
export const TARGET_COIN_TYPE =
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";

// Mainnet DEEP whale we impersonate as the funding source (the donor from the
// DEEP whale-transfer spike).
const WHALE = "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";

type ObjectRef = { objectId: string; version: string; digest: string };

// Parse a `<id>:<version>:<digest>` env override (ids/versions/digests contain
// no `:`), else use the fallback. Refs are concrete mainnet objects the fork
// serves by ref at its snapshot checkpoint — supply fresh ones if the whale's
// coins have since moved (a stale ref fails cleanly with a version error, it
// does NOT panic the fork the way `getObject` would).
function refFromEnv(env: string | undefined, fallback: ObjectRef): ObjectRef {
    if (env === undefined || env.trim() === "") return fallback;
    const [objectId, version, digest] = env.split(":");
    if (!objectId || !version || !digest) {
        throw new Error(`bad coin ref '${env}', expected '<id>:<version>:<digest>'`);
    }
    return { objectId, version, digest };
}

// The whale's live DEEP coin — a single object holding ~4.5B DEEP (verified on
// mainnet 2026-06-12). Override via DEEP_SOURCE_COIN_REF.
const DEEP_SOURCE_COIN: ObjectRef = refFromEnv(process.env.DEEP_SOURCE_COIN_REF, {
    objectId: "0x3b5cbb0b1bd8afd4dbbf5919e29e83a86ee99a2509c798950d07b4da3be2ded4",
    version: "899787250",
    digest: "DyQgpWgw86XzBNX1bwv2YSAtx8hyJNjcMuTHLP3KGWLd",
});

// A live SUI coin owned by the whale (~4 SUI), pinned as gas. Override via
// WHALE_GAS_COIN_REF.
const WHALE_GAS_COIN: ObjectRef = refFromEnv(process.env.WHALE_GAS_COIN_REF, {
    objectId: "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714",
    version: "899787250",
    digest: "HX8AqH1bz6mMYbis95DdiBT6S2Azdtu1saMoU1NjTy1C",
});

// Must match devstack's internal fork-impersonation constants so the empty-sig
// tx validates against the fork (dist/plugins/sui/fork-transaction.mjs).
const FORK_GAS_BUDGET = 100_000_000n;
const FORK_GAS_PRICE = 1_000n;

// --- The fork surfaces we use (subsets of devstack's public `sui` value) ---

type ForkCore = {
    // Empty-sig execution = impersonation. We request `effects` only.
    executeTransaction: (args: {
        transaction: Uint8Array;
        signatures: readonly string[];
        include?: { effects?: boolean; objectTypes?: boolean };
    }) => Promise<unknown>;
};
// We only need to know the fork admin surface EXISTS (non-null ⇒ fork mode);
// we deliberately do NOT call its `impersonate` (it hardcodes objectTypes:true).
type SuiForkValue = { sdk: { core: ForkCore }; fork: object | null };

// Did the executed tx revert? Parse the effects status defensively across the
// shapes @mysten/sui v2 may return; null ⇒ no failure detected.
function executionFailureReason(raw: unknown): string | null {
    const r = raw as {
        effects?: { status?: unknown };
        transaction?: { effects?: { status?: unknown } };
        finalizedEffects?: { effects?: { status?: unknown } };
    };
    const status = (r?.effects?.status ??
        r?.transaction?.effects?.status ??
        r?.finalizedEffects?.effects?.status) as
        | { success?: boolean; $kind?: string; error?: unknown; Failure?: unknown }
        | string
        | undefined;
    if (status === undefined) return null; // can't tell ⇒ assume executed
    if (typeof status === "string") {
        return status.toLowerCase().includes("fail") ? status : null;
    }
    if (
        status.success === false ||
        status.$kind === "Failure" ||
        status.Failure != null ||
        status.error != null
    ) {
        return JSON.stringify(status.error ?? status);
    }
    return null;
}

// Build the empty-sig "impersonation" tx bytes OFFLINE: gas pinned to a known
// coin ref, every object input already a concrete ref (no fork getObject). A
// re-implementation of devstack's INTERNAL buildForkImpersonationTransactionBytes
// minus the getObject input-resolution (which would panic this sui-fork rev).
async function buildImpersonationBytes(
    tx: Transaction,
    sender: string,
    gas: ObjectRef,
): Promise<Uint8Array> {
    tx.setSender(sender);
    tx.setGasBudget(FORK_GAS_BUDGET);
    tx.setGasPrice(FORK_GAS_PRICE);
    tx.setGasOwner(sender);
    tx.setGasPayment([gas]);
    if (tx.getData().expiration == null) tx.setExpiration({ None: true });
    await tx.prepareForSerialization({});
    const data = tx.getData();
    // Defensive: any unresolved input would force a fork getObject -> get_coin_info
    // -> SIGABRT. With concrete refs there are none; fail loudly if that changes.
    for (const input of data.inputs) {
        if ((input as { UnresolvedObject?: unknown }).UnresolvedObject !== undefined) {
            throw new Error(
                "deep-funding: an object input is unresolved; resolving it would call getObject, which this sui-fork rev does not implement (it panics).",
            );
        }
    }
    return TransactionDataBuilder.restore(data).build();
}

// --- The funding strategy a `{ coin: DEEP, amount }` entry dispatches to ---

function deepWhaleStrategy(suiValue: SuiForkValue): AccountFundingStrategy {
    return {
        // We don't sign as the recipient and don't spend the recipient's funds: the
        // whale is impersonated through the fork admin surface, not an account signer.
        usesAccountSigner: false,
        requiresRecipientAccount: false,
        request: ({ address, amount }) =>
            Effect.gen(function* () {
                if (amount <= 0n) return;
                const fork = suiValue.fork;
                if (fork === null) {
                    return yield* Effect.fail(
                        new Error(
                            "deep-funding: sui plugin is not in fork mode (fork admin surface is null); impersonation funding requires mode:'fork'.",
                        ),
                    );
                }
                const core = suiValue.sdk.core;

                // DEEP whale-transfer PTB: split `amount` off the whale's DEEP coin (a
                // concrete ref), send it to the recipient. Gas is the whale's SUI coin,
                // also by ref.
                const tx = new Transaction();
                const [chunk] = tx.splitCoins(tx.objectRef(DEEP_SOURCE_COIN), [
                    tx.pure.u64(amount),
                ]);
                tx.transferObjects([chunk], address);

                const bytes = yield* Effect.tryPromise({
                    try: () => buildImpersonationBytes(tx, WHALE, WHALE_GAS_COIN),
                    catch: (c) =>
                        new Error(`deep-funding: failed to build impersonation tx: ${String(c)}`),
                });

                // Empty signatures ⇒ the fork executes as the declared sender
                // (impersonation), `include: { effects: true }`. NB this still aborts a
                // STOCK fork: enriching the transfer's balance-changes calls
                // GetCoinInfo(DEEP), which misses the (un-materialized) shared Currency
                // and hits sui-fork's `todo!()` index. Validated only against the patched
                // fork (.fork-patched/) — priming the Currency is impossible on a stock
                // fork (touching the coin-typed Currency object itself aborts). See
                // SUI-FORK-NOTES.md.
                const raw = yield* Effect.tryPromise({
                    try: () =>
                        core.executeTransaction({
                            transaction: bytes,
                            signatures: [],
                            include: { effects: true },
                        }),
                    catch: (c) =>
                        new Error(
                            `deep-funding: empty-sig execute (impersonation) failed: ${String(c)}`,
                        ),
                });
                const failure = executionFailureReason(raw);
                if (failure !== null) {
                    return yield* Effect.fail(
                        new Error(
                            `deep-funding: impersonation tx reverted on the fork: ${failure}`,
                        ),
                    );
                }
            }),
    };
}

// Factory: depends only on the `sui` network — the impersonation source (whale,
// source coin, gas coin) is the plugin's own concern. The strategy closes over
// the resolved sui value (`sdk.core` + the fork admin surface).
export function deepFunding(suiRef: ReturnType<typeof sui>) {
    return definePlugin({
        id: "deep-funding",
        role: "service",
        dependsOn: { sui: suiRef },
        start: (deps) => Effect.succeed({ sui: deps.sui }),
        capabilities: ({ value }) => [
            strategyContributor({
                // The key the account-funding pass dispatches `{ coin: DEEP, amount }` to.
                // Built-in coin.* plugins contribute the same key at priority 0 (a
                // mint-backed strategy, wrong for fixed-supply DEEP); ours wins at 1.
                capabilityKey: `coinType:${TARGET_COIN_TYPE}`,
                strategy: deepWhaleStrategy(value.sui as unknown as SuiForkValue),
                autoMounted: false,
                priority: 1,
            }),
        ],
        section: "service",
    });
}

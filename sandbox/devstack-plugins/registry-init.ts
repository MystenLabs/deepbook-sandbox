// Boot-time DeepBook registry init as a devstack task member (SEDEFI-456) —
// makes user-driven BalanceManager registration possible on the fork.
//
// Mainnet has never called `registry::init_balance_manager_map` (verified
// live: the derived `BalanceManagerKey` dynamic field is absent at the fork
// pin), so the trading dashboard's create-BM PTB — which bundles
// `register_balance_manager` — would abort on the missing field. The pinned
// mainnet package v8 DOES ship the function (verified via getMoveFunction),
// and it is admin-gated + idempotent (`if !exists`), so this member
// impersonates the manifest's adminWallet once per chain and calls it.
//
// Fork accommodations (SUI-FORK-ISSUES):
//   - #2 execution child reads don't lazy-fetch: the call's `load_inner_mut`
//     reads the registry's inner `Versioned` dynamic field, which is pre-fork
//     state — pre-warm it by derived field id before executing. Registry has
//     the same `{ id: UID, inner: Versioned }` layout as Pool, so the
//     trade-sim offset recipe applies (inner UID at bytes 32..64, version at
//     64..72).
//   - Gas: the admin owns no enumerable SUI on the fork (no owner→coins index
//     for pre-fork state), so gas comes from devstack's fork faucet strategy
//     when it exists — but that strategy is structurally null on forks (see
//     fork-sui-grant.ts), so the working path is a whale-impersonated SUI
//     grant; the granted coin is fork-local and therefore enumerable.

import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { deriveDynamicFieldID } from "@mysten/sui/utils";
import { Effect } from "effect";
import { definePlugin, type sui } from "@mysten-incubation/devstack";

import { memberError } from "./container-util.ts";
import { mainnetForkDeepbookIds } from "./deepbook-known.ts";
import { suiGrantViaWhale, type FullCore } from "./fork-sui-grant.ts";

const MEMBER = "registry-init";
const fail = memberError(MEMBER);

// Must match devstack's internal fork-impersonation constants (same pins as
// deep-funding.ts / trade-sim.ts).
const GAS_BUDGET = 100_000_000n;
const GAS_PRICE = 1_000n;
/** Faucet draw for the admin's gas — one init call needs far less; the rest
 *  stays as runway for future admin-impersonated boot tasks. */
const ADMIN_GAS_MIST = 2_000_000_000n; // 2 SUI
/** Whale-grant fallback — the pinned whale coin is small (fractions of a
 *  SUI), so the fallback grants just enough for the init tx's budget. */
const ADMIN_GAS_FALLBACK_MIST = 150_000_000n; // 0.15 SUI

type ObjectRef = { objectId: string; version: string; digest: string };

/** The fork-guarded gRPC core slice this member uses (getObject passes the
 *  guard; enumeration only works for fork-local objects). */
type InitCore = {
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
};

/** Empty-sig impersonation bytes — offline, concrete refs only (the fork has
 *  no simulate_transaction; an unresolved input means a build bug here). */
const buildImpersonationBytes = async (
    tx: Transaction,
    sender: string,
    gas: ObjectRef,
): Promise<Uint8Array> => {
    tx.setSender(sender);
    tx.setGasBudget(GAS_BUDGET);
    tx.setGasPrice(GAS_PRICE);
    tx.setGasOwner(sender);
    tx.setGasPayment([gas]);
    if (tx.getData().expiration == null) tx.setExpiration({ None: true });
    await tx.prepareForSerialization({});
    for (const input of tx.getData().inputs) {
        if ((input as { UnresolvedObject?: unknown }).UnresolvedObject !== undefined) {
            throw new Error("unresolved object input — build PTBs with concrete refs only");
        }
    }
    return TransactionDataBuilder.restore(tx.getData()).build();
};

/** On-chain failure reason from the execution envelope (both fork shapes). */
const revertReason = (raw: unknown): string => {
    type Status = { success?: boolean; error?: unknown };
    type Tx = { status?: Status; effects?: { status?: Status } };
    const r = raw as { $kind?: string; Transaction?: Tx; FailedTransaction?: Tx };
    const status =
        r?.FailedTransaction?.status ??
        r?.FailedTransaction?.effects?.status ??
        r?.Transaction?.status ??
        r?.Transaction?.effects?.status;
    return JSON.stringify(status?.error ?? status ?? "no status in envelope").slice(0, 400);
};

/** The package version that INTRODUCED `registry::BalanceManagerKey` —
 *  dynamic-field type tags carry a struct's DEFINING id, which for structs
 *  added in an upgrade is neither the original nor necessarily the latest
 *  package id. Recovered from a live register_balance_manager execution
 *  envelope (SEDEFI-456); fixed mainnet state. Mirrored in
 *  sandbox/dashboard/src/lib/fork.ts. */
export const BALANCE_MANAGER_KEY_DEFINING_PKG =
    "0x00c1a56ec8c4c623a848b2ed2f03d23a25d17570b670c22106f336eb933785cc";

/** Derived id of the registry's `BalanceManagerKey {}` dynamic field — the
 *  BM map. An empty Move struct serializes as BCS [0]. */
export const balanceManagerMapFieldId = (registryId: string): string =>
    deriveDynamicFieldID(
        registryId,
        `${BALANCE_MANAGER_KEY_DEFINING_PKG}::registry::BalanceManagerKey`,
        new Uint8Array([0]),
    );

export type RegistryInitOptions = {
    sui: ReturnType<typeof sui>;
    manifestPath?: string;
};

export function registryInitMember(opts: RegistryInitOptions) {
    return definePlugin({
        id: MEMBER,
        role: "task",
        section: "action",
        dependsOn: { sui: opts.sui },
        start: (deps) =>
            Effect.gen(function* () {
                const fork = deps.sui.fork;
                if (fork === null) {
                    return yield* Effect.fail(
                        fail("mode", "registry-init requires sui mode:'fork'"),
                    );
                }
                // The FULL client's core — NOT the narrow sdk.core shim,
                // which lacks listOwnedObjects (calling a missing method
                // there kills the whole supervisor, observed live).
                const core = deps.sui.sdk.client.core as unknown as InitCore;
                const ids = mainnetForkDeepbookIds(opts.manifestPath);
                const admin = ids.adminWallet;
                const registry = ids.registry;
                const latestPkg = ids.packages.deepbook.latestId;

                // Idempotency short-circuit: map already there (a previous boot
                // on this chain — the field is fork-local once created).
                const mapId = balanceManagerMapFieldId(registry.objectId);
                const existing = yield* Effect.promise(() =>
                    core
                        .getObject({ objectId: mapId })
                        .then(() => true)
                        .catch(() => false),
                );
                if (existing) {
                    return { initialized: false as const, balanceManagerMapId: mapId };
                }

                // Pre-warm the SYSTEM packages + clock before the chain's
                // FIRST fork-local execution: on a fresh fork chain the first
                // commit's ConsensusCommitPrologue panic-aborts the process
                // with "Cannot find package 0x…02 in data cache" when nothing
                // has lazily materialized the framework yet (observed live,
                // SEDEFI-456; resumed chains never hit this). getObject by id
                // materializes them into the store.
                yield* Effect.promise(async () => {
                    for (const id of ["0x1", "0x2", "0x3", "0x5", "0x6"]) {
                        await core.getObject({ objectId: id }).catch(() => null);
                    }
                });

                // Pre-warm the registry's inner Versioned dynamic field (#2).
                const warmed = yield* Effect.promise(async () => {
                    const reg = await core.getObject({
                        objectId: registry.objectId,
                        include: { content: true },
                    });
                    const content = reg.object?.content;
                    if (!content || content.length < 72) return false;
                    const innerUid = `0x${Buffer.from(content.slice(32, 64)).toString("hex")}`;
                    const innerVersion = new DataView(
                        content.buffer,
                        content.byteOffset + 64,
                        8,
                    ).getBigUint64(0, true);
                    const innerFieldId = deriveDynamicFieldID(
                        innerUid,
                        "u64",
                        bcs.u64().serialize(innerVersion).toBytes(),
                    );
                    return core
                        .getObject({ objectId: innerFieldId })
                        .then(() => true)
                        .catch(() => false);
                });
                if (!warmed) {
                    return yield* Effect.fail(
                        fail("prewarm", "could not pre-warm the registry inner Versioned field"),
                    );
                }

                // Gas for the admin: faucet when it exists, whale grant
                // otherwise (fork-local either way ⇒ enumerable).
                const faucet = deps.sui.fundingFaucetStrategy;
                if (faucet !== null) {
                    yield* faucet
                        .request({ address: admin, amount: ADMIN_GAS_MIST })
                        .pipe(
                            Effect.catch((cause) =>
                                Effect.fail(fail("gas", "admin gas faucet request failed", cause)),
                            ),
                        );
                } else {
                    yield* Effect.tryPromise({
                        try: () =>
                            suiGrantViaWhale(
                                core as unknown as FullCore,
                                admin,
                                ADMIN_GAS_FALLBACK_MIST,
                            ),
                        catch: (cause) =>
                            fail("gas", `admin gas whale grant failed: ${String(cause)}`, cause),
                    });
                }
                const gasRef = yield* Effect.tryPromise({
                    try: async () => {
                        const owned = await core.listOwnedObjects({ owner: admin });
                        const coin = (owned.objects ?? []).find(
                            (o) =>
                                String(o.type ?? "").includes("::coin::Coin<") &&
                                String(o.type ?? "").includes("::sui::SUI"),
                        );
                        if (!coin) throw new Error("no fork-local SUI coin on the admin");
                        const res = await core.getObject({ objectId: coin.objectId });
                        const obj = res.object;
                        if (!obj) throw new Error(`gas coin ${coin.objectId} vanished`);
                        return {
                            objectId: obj.objectId,
                            version: String(obj.version),
                            digest: obj.digest,
                        };
                    },
                    catch: (cause) =>
                        fail(
                            "gas",
                            `resolving the admin's faucet gas coin: ${String(cause)}`,
                            cause,
                        ),
                });

                // AdminCap is admin-owned pre-fork state: resolve a concrete ref
                // by known id (materializes on direct access).
                const capRef = yield* Effect.tryPromise({
                    try: async () => {
                        const res = await core.getObject({
                            objectId: ids.deepbookAdminCap.objectId,
                        });
                        const obj = res.object;
                        if (!obj) throw new Error("DeepbookAdminCap not found on the fork");
                        return {
                            objectId: obj.objectId,
                            version: String(obj.version),
                            digest: obj.digest,
                        };
                    },
                    catch: (cause) => fail("admin-cap", String(cause), cause),
                });

                const tx = new Transaction();
                tx.moveCall({
                    target: `${latestPkg}::registry::init_balance_manager_map`,
                    arguments: [
                        tx.sharedObjectRef({
                            objectId: registry.objectId,
                            initialSharedVersion: registry.initialSharedVersion,
                            mutable: true,
                        }),
                        tx.objectRef(capRef),
                    ],
                });
                const bytes = yield* Effect.tryPromise({
                    try: () => buildImpersonationBytes(tx, admin, gasRef),
                    catch: (cause) => fail("build-tx", String(cause), cause),
                });
                const result = yield* fork
                    .impersonate(admin, bytes)
                    .pipe(
                        Effect.catch((cause) =>
                            Effect.fail(fail("execute", `init tx failed: ${String(cause)}`, cause)),
                        ),
                    );
                if (!result.success) {
                    return yield* Effect.fail(
                        fail(
                            "execute",
                            `init tx ${result.digest} reverted: ${revertReason(result.raw)}`,
                        ),
                    );
                }

                return { initialized: true as const, balanceManagerMapId: mapId };
            }),
    });
}

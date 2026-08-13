// Continuous trade simulator as a devstack member — keeps the dashboard's
// DeepBook Price panel and /ticker live by self-filling orders on the fork
// every SIM_INTERVAL_MS (default 600ms).
//
// ⚠️ STATUS (WIP): produces the first fills/candles, then stalls when the
// straddle overlaps the real pin-era spread — the resting bid crosses the
// real ask and market-buys until the manager's quote is gone
// (EBalanceManagerBalanceTooLow). Root cause is that the straddle is placed
// around a GUESSED mid while the real spread's location is unknown. Designed
// fix (v4, next commit): measure the real bid/ask once with two tiny probe
// IOCs (fill prices read back from order_fills), then clamp the self-fill
// pair STRICTLY inside the measured spread, recalibrating on failure
// streaks. Restarting the stack recovers the sim in the meantime.
//
// Mechanism (the one-shot backfill sibling is scripts/seed-trades.ts; the
// primitives are ported from it and from deep-funding.ts):
//   - Impersonated execution via `deps.sui.fork.impersonate` (empty-sig, gRPC
//     ForkingService) — no signing, no docker exec. Sender is the DEEP whale.
//   - TWO txs per tick. TX A: cancel_all_orders + withdraw_settled_amounts —
//     reclaim in its own always-committing tx (cleanup sharing a tx with the
//     orders means an aborting bid reverts the cleanup too, wedging the
//     manager permanently — observed live in three earlier variants). TX B:
//     a RESTING straddle pair (bid @ X−2 ticks, ask @ X+2) + ONE IOC that
//     crosses INTO the straddle (direction by inventory: base above its
//     funded target ⇒ sell). The straddle guarantees the IOC a counterparty
//     — our own order — so fills never depend on the pin-era book's depth
//     (crossing-only designs stall once they eat the static book's top
//     levels; same-price self-fills lock up when the unknown real spread
//     sits inside the range — both observed live). Real orders tighter than
//     the straddle still win price priority: more realism, not a problem.
//   - The walk's center self-calibrates from the server's own last fill
//     price (/ticker), so X tracks wherever trading actually happens.
//   - Default pool DEEP_SUI only: it is whitelisted (zero input-token fees),
//     so cycling leaks nothing. SIM_POOLS extends it; non-whitelisted pools
//     leak fees per fill and will eventually drain the manager.
//   - Crossing a POISONED pin-era maker aborts the tick (SUI-FORK-ISSUES
//     #2) — caught, counted, and the walk moves on.
//   - Clock: fills are only visible to the server's wall-relative windows if
//     checkpoint timestamps track wall time (SUI-FORK-ISSUES #6) — the loop
//     advances the fork Clock toward `Date.now()` after every fill
//     (forward-only, NEVER past wall: future-stamped fills vanish from every
//     window until wall time catches up).
//   - OHLCV: `ohclv_1m/1d` are plain tables production fills via pg_cron
//     (absent in postgres:16-alpine) — a second loop CALLs update_ohclv_*
//     through the postgres member's container handle every few seconds.
//
// Chart expectations: /ohclv has no interval below 1m, so the Price panel
// grows ONE new point per minute; sub-minute fills update the current
// candle's close and the /ticker last price — that is the "live" feel.
//
// Gas: the whale's pinned SUI coin is small (~4 SUI). The loop tracks the gas
// coin's version from tx effects (no per-tick re-read) and, when the balance
// runs low, tops the whale up through devstack's fork faucet strategy
// (impersonates devstack's seeded SUI whale) and merges the fresh coin into
// the gas coin on the next tick. Without the faucet strategy it warns and
// trades until dry.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { deriveDynamicFieldID } from "@mysten/sui/utils";
import { Duration, Effect, Schedule } from "effect";
import {
    ContainerRuntimeService,
    definePlugin,
    type ContainerRuntime,
    type sui,
} from "@mysten-incubation/devstack";

import { memberError } from "./container-util.ts";
import { mainnetForkDeepbookIds } from "./deepbook-known.ts";
import type { indexerMember } from "./indexer-member.ts";
import type { poolsSeedMember } from "./pools-seed.ts";
import type { postgresMember } from "./postgres-member.ts";

const MEMBER = "trade-sim";
const fail = memberError(MEMBER);

const HERE = dirname(fileURLToPath(import.meta.url));
/** BalanceManager reuse across restarts — funds parked in an abandoned
 *  manager are gone (the whale's SUI is scarce). Wiped forks invalidate the
 *  file via the on-chain existence probe. Gitignored. */
const STATE_PATH = resolve(HERE, ".trade-sim-state.json");

// Same pins as deep-funding.ts / seed-trades.ts (fork-impersonation.md).
const WHALE =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const WHALE_DEEP_COIN =
    process.env.DEEP_DONOR_COIN_ID?.trim() ||
    "0x5f6e1d15c2b42ddbe4a827d509857184ea52c425fbe02ba91cae0cb71e40888e";
const WHALE_GAS_COIN =
    process.env.SUI_GAS_COIN_ID?.trim() ||
    "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714";

const GAS_BUDGET = 100_000_000n;
const GAS_PRICE = 1_000n;
const MAX_TIMESTAMP = 1_844_674_407_370_955_161n; // SDK MAX_TIMESTAMP

const DEFAULT_INTERVAL_MS = 600;
const DEFAULT_OHLCV_MS = 8_000;
/** Refill when the gas coin drops below this; top up by REFILL_MIST. */
const GAS_LOW_WATER_MIST = 1_000_000_000n; // 1 SUI
const GAS_REFILL_MIST = 10_000_000_000n; // 10 SUI
/** Ticks between gas-balance checks (a balance read is one getObject). */
const GAS_CHECK_EVERY = 64;
/** Pin-era oracle mids — good enough centers for a sandbox chart; the walk
 *  provides the movement. (Live Pyth reads are deliberately not a dependency:
 *  the sim must keep ticking when feeds are stale.) */
const USD_FALLBACK: Record<string, number> = { DEEP: 0.0162, SUI: 0.692, USDC: 1.0 };
const DECIMALS: Record<string, number> = { DEEP: 6, SUI: 9, USDC: 6 };
const POOL_QTY: Record<string, bigint> = {
    DEEP_SUI: 40_000_000n, // 40 DEEP
    DEEP_USDC: 40_000_000n,
    SUI_USDC: 1_000_000_000n, // the pool's min size
};

type ObjectRef = { objectId: string; version: string; digest: string };

/** The slice of the fork-guarded gRPC core the sim uses (getObject passes the
 *  guard; balance/enumeration surfaces are blocked or fork-empty). */
type SimCore = {
    getObject: (args: {
        objectId: string;
        include?: { content?: boolean; json?: boolean };
    }) => Promise<{
        object?: {
            objectId: string;
            version: string;
            digest: string;
            type?: string;
            content?: Uint8Array;
            json?: unknown;
        };
    }>;
    listOwnedObjects: (args: {
        owner: string;
    }) => Promise<{ objects?: { objectId: string; type?: string }[] }>;
};

const coinSymbol = (coinType: string): string => coinType.split("::").pop() ?? coinType;

/** Build empty-sig impersonation bytes — offline, concrete refs only (the
 *  fork has no simulate_transaction; an unresolved input means a build bug). */
const buildImpersonationBytes = async (
    tx: Transaction,
    sender: string,
    gas: readonly ObjectRef[],
): Promise<Uint8Array> => {
    tx.setSender(sender);
    tx.setGasBudget(GAS_BUDGET);
    tx.setGasPrice(GAS_PRICE);
    tx.setGasOwner(WHALE);
    tx.setGasPayment([...gas]);
    if (tx.getData().expiration == null) tx.setExpiration({ None: true });
    await tx.prepareForSerialization({});
    const data = tx.getData();
    for (const input of data.inputs) {
        if ((input as { UnresolvedObject?: unknown }).UnresolvedObject !== undefined) {
            throw new Error("unresolved object input — build PTBs with concrete refs only");
        }
    }
    return TransactionDataBuilder.restore(data).build();
};

type ChangedObject = {
    objectId?: string;
    idOperation?: string;
    outputVersion?: string | number;
    outputDigest?: string;
};

const changedObjects = (
    raw: unknown,
): { changed: ChangedObject[]; types: Record<string, string> } => {
    const tx = (raw as { Transaction?: unknown }).Transaction as
        | { effects?: { changedObjects?: ChangedObject[] }; objectTypes?: Record<string, string> }
        | undefined;
    return { changed: tx?.effects?.changedObjects ?? [], types: tx?.objectTypes ?? {} };
};

/** Extract the on-chain failure reason from the execution envelope (both the
 *  FailedTransaction and status.success=false shapes the fork emits). */
const revertReason = (raw: unknown): string => {
    type Status = { success?: boolean; error?: unknown };
    type Tx = { status?: Status; effects?: { status?: Status } };
    const r = raw as { $kind?: string; Transaction?: Tx; FailedTransaction?: Tx };
    const failed =
        r?.FailedTransaction ??
        (r?.$kind === "FailedTransaction" ? r.FailedTransaction : undefined);
    const status =
        failed?.status ??
        failed?.effects?.status ??
        r?.Transaction?.status ??
        r?.Transaction?.effects?.status;
    return JSON.stringify(status?.error ?? status ?? "no status in envelope").slice(0, 400);
};

/** Refresh a tracked ref from a tx's effects (saves a getObject per tick). */
const refreshedRef = (raw: unknown, ref: ObjectRef): ObjectRef => {
    const { changed } = changedObjects(raw);
    for (const c of changed) {
        if (c.objectId === ref.objectId && c.outputVersion !== undefined) {
            return {
                objectId: ref.objectId,
                version: String(c.outputVersion),
                digest: String(c.outputDigest ?? ref.digest),
            };
        }
    }
    return ref;
};

/** Coin<SUI> balance from a Coin object's BCS content (u64 LE after the UID). */
const coinBalanceFromContent = (content: Uint8Array | undefined): bigint => {
    if (!content || content.length < 40) return 0n;
    return new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true);
};

export type TradeSimOptions = {
    sui: ReturnType<typeof sui>;
    postgres: ReturnType<typeof postgresMember>;
    /** ordering only: fills need the pools config + a live ingestion path. */
    poolsSeed: ReturnType<typeof poolsSeedMember>;
    indexer: ReturnType<typeof indexerMember>;
    /** pool names from the manifest (default DEEP_SUI — the whitelisted,
     *  zero-fee pool; env SIM_POOLS). */
    pools?: string[];
    /** tick cadence (default 600ms; env SIM_INTERVAL_MS). */
    intervalMs?: number;
    /** OHLCV aggregation cadence (default 8s; env SIM_OHLCV_MS). */
    ohlcvMs?: number;
    manifestPath?: string;
};

export function tradeSimMember(opts: TradeSimOptions) {
    const disabled = process.env.SIM_DISABLED === "1";
    const poolNames = (process.env.SIM_POOLS?.trim() || (opts.pools ?? ["DEEP_SUI"]).join(","))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const intervalMs = Number(
        process.env.SIM_INTERVAL_MS ?? opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    const ohlcvMs = Number(process.env.SIM_OHLCV_MS ?? opts.ohlcvMs ?? DEFAULT_OHLCV_MS);
    if (!Number.isFinite(intervalMs) || intervalMs < 100) {
        throw new Error(`trade-sim: SIM_INTERVAL_MS must be >= 100 (got ${intervalMs})`);
    }

    return definePlugin({
        id: MEMBER,
        role: "service",
        section: "service",
        dependsOn: {
            sui: opts.sui,
            postgres: opts.postgres,
            poolsSeed: opts.poolsSeed,
            indexer: opts.indexer,
        },
        start: (deps) =>
            Effect.gen(function* () {
                if (disabled) {
                    return { enabled: false as const, reason: "SIM_DISABLED=1" };
                }
                const fork = deps.sui.fork;
                if (fork === null) {
                    return yield* Effect.fail(
                        fail("mode", "trade-sim requires sui mode:'fork' (no fork admin surface)"),
                    );
                }
                const core = deps.sui.sdk.core as unknown as SimCore;
                const runtime = yield* ContainerRuntimeService;

                const ids = mainnetForkDeepbookIds(opts.manifestPath);
                const pkg = ids.packages.deepbook.latestId;
                const origPkg = ids.packages.deepbook.originalId;

                const stats = {
                    fills: 0,
                    failures: 0,
                    consecutiveFailures: 0,
                    gasRefills: 0,
                    lastError: null as string | null,
                };

                const getRef = (objectId: string): Effect.Effect<ObjectRef, unknown> =>
                    Effect.tryPromise({
                        try: async () => {
                            const res = await core.getObject({ objectId });
                            const o = res.object;
                            if (!o) throw new Error(`object ${objectId} not found on the fork`);
                            return {
                                objectId: o.objectId,
                                version: String(o.version),
                                digest: o.digest,
                            };
                        },
                        catch: (cause) =>
                            fail("get-ref", `getObject(${objectId}): ${String(cause)}`, cause),
                    });

                const impersonate = (
                    tx: Transaction,
                    sender: string,
                    gas: readonly ObjectRef[],
                    label: string,
                ): Effect.Effect<unknown, unknown> =>
                    Effect.gen(function* () {
                        const bytes = yield* Effect.tryPromise({
                            try: () => buildImpersonationBytes(tx, sender, gas),
                            catch: (cause) => fail("build-tx", `${label}: ${String(cause)}`, cause),
                        });
                        const result = yield* fork
                            .impersonate(sender, bytes)
                            .pipe(
                                Effect.catch((cause) =>
                                    Effect.fail(
                                        fail("execute", `${label}: ${String(cause)}`, cause),
                                    ),
                                ),
                            );
                        if (!result.success) {
                            return yield* Effect.fail(
                                fail(
                                    "execute",
                                    `${label}: tx ${result.digest} reverted: ${revertReason(result.raw)}`,
                                ),
                            );
                        }
                        return result.raw;
                    });

                // --- clock catch-up (SUI-FORK-ISSUES #6): fills must land inside
                // the server's wall-relative windows. Forward-only, never past wall.
                const status = yield* fork.status.pipe(
                    Effect.catch((cause) =>
                        Effect.fail(fail("status", "fork status read failed", cause)),
                    ),
                );
                let chainClock = status.clock;
                const catchUp = Date.now() - chainClock;
                if (catchUp > 0) {
                    yield* fork
                        .advanceClock(catchUp)
                        .pipe(
                            Effect.catch((cause) =>
                                Effect.fail(fail("clock", "initial clock catch-up failed", cause)),
                            ),
                        );
                    chainClock += catchUp;
                }

                // --- gas coin (version tracked from effects after each tx) ------
                let gasRef = yield* getRef(WHALE_GAS_COIN);
                /** faucet-funded coin waiting to be merged into the gas coin. */
                let pendingGasTopUp: ObjectRef | null = null;
                const knownGasIds = new Set<string>([WHALE_GAS_COIN]);

                // The whale's pinned coin (~4 SUI) can't cover the 3× quote
                // funding below AND leave gas runway — top up from the fork
                // faucet up-front when it's available. The faucet coin is
                // fork-local, so enumeration finds it; it merges into the gas
                // coin as a second gas payment on the first setup tx.
                if (deps.sui.fundingFaucetStrategy !== null) {
                    yield* deps.sui.fundingFaucetStrategy
                        .request({ address: WHALE, amount: 20_000_000_000n })
                        .pipe(Effect.catch(() => Effect.void));
                    const owned = yield* Effect.promise(() =>
                        core.listOwnedObjects({ owner: WHALE }).catch(() => ({ objects: [] })),
                    );
                    const fresh = (owned.objects ?? []).find(
                        (o) =>
                            String(o.type ?? "").includes("::coin::Coin<") &&
                            String(o.type ?? "").includes("::sui::SUI") &&
                            !knownGasIds.has(o.objectId),
                    );
                    if (fresh) {
                        knownGasIds.add(fresh.objectId);
                        pendingGasTopUp = yield* getRef(fresh.objectId).pipe(
                            Effect.catch(() => Effect.succeed(null)),
                        );
                    }
                }

                /** Gas payment for the next tx — merges any pending faucet
                 *  top-up into the tracked gas coin (multi-coin gas payments
                 *  merge on execution). */
                const takeGasPayment = (): ObjectRef[] => {
                    const payment = pendingGasTopUp ? [gasRef, pendingGasTopUp] : [gasRef];
                    pendingGasTopUp = null;
                    return payment;
                };

                // --- BalanceManager: reuse or create ----------------------------
                let bm: { objectId: string; version: string } | null = null;
                if (existsSync(STATE_PATH)) {
                    const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
                        objectId?: string;
                        version?: string;
                    };
                    if (saved.objectId && saved.version) {
                        const alive = yield* Effect.promise(() =>
                            core.getObject({ objectId: saved.objectId! }).catch(() => null),
                        );
                        if (alive?.object)
                            bm = { objectId: saved.objectId, version: saved.version };
                    }
                }
                if (bm === null) {
                    const tx = new Transaction();
                    const manager = tx.moveCall({ target: `${pkg}::balance_manager::new` });
                    tx.moveCall({
                        target: "0x2::transfer::public_share_object",
                        arguments: [manager],
                        typeArguments: [`${pkg}::balance_manager::BalanceManager`],
                    });
                    const raw = yield* impersonate(
                        tx,
                        WHALE,
                        takeGasPayment(),
                        "create BalanceManager",
                    );
                    gasRef = refreshedRef(raw, gasRef);
                    const { changed, types } = changedObjects(raw);
                    const created = changed.find(
                        (c) =>
                            String(c.idOperation ?? "").toUpperCase() === "CREATED" &&
                            String(types[c.objectId ?? ""] ?? "").includes(
                                "::balance_manager::BalanceManager",
                            ),
                    );
                    if (!created?.objectId) {
                        return yield* Effect.fail(
                            fail("balance-manager", "created BalanceManager not found in effects"),
                        );
                    }
                    bm = {
                        objectId: created.objectId,
                        version: String(created.outputVersion ?? ""),
                    };
                    writeFileSync(STATE_PATH, JSON.stringify(bm, null, 4) + "\n");
                }
                const bmFinal = bm;
                const bmRef = (tx: Transaction) =>
                    tx.sharedObjectRef({
                        objectId: bmFinal.objectId,
                        initialSharedVersion: bmFinal.version,
                        mutable: true,
                    });

                /** Manager balance via the Bag's derived dynamic field (the fork
                 *  has no balance index; BalanceKey<T> is an empty struct — BCS
                 *  [0] — keyed at the ORIGINAL package id). */
                const bmBalance = (coinType: string): Effect.Effect<bigint> =>
                    Effect.promise(async () => {
                        try {
                            const bmObj = await core.getObject({
                                objectId: bmFinal.objectId,
                                include: { content: true },
                            });
                            const content = bmObj.object?.content;
                            if (!content || content.length < 96) return 0n;
                            const bagUid = `0x${Buffer.from(content.slice(64, 96)).toString("hex")}`;
                            const fieldId = deriveDynamicFieldID(
                                bagUid,
                                `${origPkg}::balance_manager::BalanceKey<${coinType}>`,
                                new Uint8Array([0]),
                            );
                            const field = await core.getObject({
                                objectId: fieldId,
                                include: { content: true },
                            });
                            const bytes = field.object?.content;
                            if (!bytes || bytes.length < 41) return 0n;
                            return new DataView(
                                bytes.buffer,
                                bytes.byteOffset + 33,
                                8,
                            ).getBigUint64(0, true);
                        } catch {
                            return 0n;
                        }
                    });

                // --- per-pool setup: prewarm + one-time funding ------------------
                type PoolState = {
                    name: string;
                    pin: (typeof ids.pools)[string];
                    qty: bigint;
                    tick: bigint;
                    priceMult: bigint;
                    centerTicks: bigint;
                    walkTicks: bigint;
                    clientOrderId: bigint;
                    /** funded base amount — inventory above it ⇒ sell tick. */
                    targetBase: bigint;
                };
                const pools: PoolState[] = [];
                for (const name of poolNames) {
                    const pin = ids.pools[name];
                    if (!pin) {
                        return yield* Effect.fail(
                            fail("pool", `pool ${name} not in the manifest (SIM_POOLS typo?)`),
                        );
                    }
                    const baseSym = coinSymbol(pin.baseType);
                    const quoteSym = coinSymbol(pin.quoteType);
                    const baseDec = DECIMALS[baseSym] ?? 9;
                    const quoteDec = DECIMALS[quoteSym] ?? 9;
                    const mid = (USD_FALLBACK[baseSym] ?? 1) / (USD_FALLBACK[quoteSym] ?? 1);
                    const qty = POOL_QTY[name] ?? 10_000_000n;
                    const priceMult = 10n ** BigInt(9 + quoteDec - baseDec);
                    const tick = BigInt(pin.tickSize);
                    // SIM_TICK_BIAS nudges the whole walk out of a hostile book
                    // region (poisoned pin-era makers) — same knob seed-trades has.
                    const centerTicks =
                        BigInt(Math.round((mid * Number(priceMult)) / Number(tick))) +
                        BigInt(process.env.SIM_TICK_BIAS ?? 0);

                    // Pre-warm the pool's Versioned inner (execution child reads
                    // don't lazy-fetch on the fork — SUI-FORK-ISSUES / SEDEFI-448).
                    const warmed = yield* Effect.promise(async () => {
                        const poolObj = await core.getObject({
                            objectId: pin.objectId,
                            include: { content: true },
                        });
                        const content = poolObj.object?.content;
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
                            fail("prewarm", `could not pre-warm pool inner for ${name}`),
                        );
                    }

                    // A REUSED manager may hold funds locked in leftover resting
                    // orders from a previous run — reclaim before topping up from
                    // the whale.
                    {
                        const tx = new Transaction();
                        const proof = tx.moveCall({
                            target: `${pkg}::balance_manager::generate_proof_as_owner`,
                            arguments: [bmRef(tx)],
                        });
                        const poolShared = tx.sharedObjectRef({
                            objectId: pin.objectId,
                            initialSharedVersion: pin.initialSharedVersion,
                            mutable: true,
                        });
                        tx.moveCall({
                            target: `${pkg}::pool::cancel_all_orders`,
                            arguments: [poolShared, bmRef(tx), proof, tx.object.clock()],
                            typeArguments: [pin.baseType, pin.quoteType],
                        });
                        tx.moveCall({
                            target: `${pkg}::pool::withdraw_settled_amounts`,
                            arguments: [poolShared, bmRef(tx), proof],
                            typeArguments: [pin.baseType, pin.quoteType],
                        });
                        const raw = yield* impersonate(
                            tx,
                            WHALE,
                            takeGasPayment(),
                            `${name} reclaim`,
                        );
                        gasRef = refreshedRef(raw, gasRef);
                    }

                    // One-time funding: the tick locks a straddle pair + an IOC
                    // leg concurrently (≈2× each side) — 3× headroom keeps the
                    // whitelisted (zero-fee) cycle solvent forever.
                    const needs = new Map<string, bigint>();
                    needs.set(pin.baseType, qty * 3n);
                    needs.set(
                        pin.quoteType,
                        BigInt(Math.ceil(Number(qty) * mid * Math.pow(10, quoteDec - baseDec) * 3)),
                    );
                    for (const [coinType, needed] of needs) {
                        const have = yield* bmBalance(coinType);
                        if (have >= needed) continue;
                        const shortfall = needed - have;
                        const sym = coinSymbol(coinType);
                        const tx = new Transaction();
                        if (sym === "SUI") {
                            const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(shortfall)]);
                            tx.moveCall({
                                target: `${pkg}::balance_manager::deposit`,
                                arguments: [bmRef(tx), chunk],
                                typeArguments: [coinType],
                            });
                        } else if (sym === "DEEP") {
                            const deepRef = yield* getRef(WHALE_DEEP_COIN);
                            const [chunk] = tx.splitCoins(tx.objectRef(deepRef), [
                                tx.pure.u64(shortfall),
                            ]);
                            tx.moveCall({
                                target: `${pkg}::balance_manager::deposit`,
                                arguments: [bmRef(tx), chunk],
                                typeArguments: [coinType],
                            });
                        } else {
                            // USDC needs the mint flow — keep the always-on sim to
                            // DEEP/SUI pools; seed-trades covers USDC pools one-shot.
                            return yield* Effect.fail(
                                fail(
                                    "funding",
                                    `pool ${name} needs ${sym} funding — the sim only self-funds SUI/DEEP ` +
                                        "(run scripts/seed-trades.ts for USDC pools, or extend the sim)",
                                ),
                            );
                        }
                        const raw = yield* impersonate(
                            tx,
                            WHALE,
                            takeGasPayment(),
                            `deposit ${sym}`,
                        );
                        gasRef = refreshedRef(raw, gasRef);
                    }

                    pools.push({
                        name,
                        pin,
                        qty,
                        tick,
                        priceMult,
                        centerTicks,
                        walkTicks: 0n,
                        clientOrderId: BigInt(Date.now()) * 1000n,
                        targetBase: (qty * 23n) / 20n,
                    });
                }

                /** Recenter a pool's walk on the server's last real fill price —
                 *  the sim's only reliable view of where the pin-era book
                 *  actually trades (no dev_inspect on the fork). */
                const recenter = (pool: PoolState): Effect.Effect<void> =>
                    Effect.promise(async () => {
                        try {
                            const res = await fetch(`http://127.0.0.1:9008/ticker`, {
                                signal: AbortSignal.timeout(3_000),
                            });
                            const body = (await res.json()) as Record<
                                string,
                                { last_price?: number }
                            >;
                            const last = body[pool.name]?.last_price ?? 0;
                            if (Number.isFinite(last) && last > 0) {
                                pool.centerTicks = BigInt(
                                    Math.round((last * Number(pool.priceMult)) / Number(pool.tick)),
                                );
                            }
                        } catch {
                            /* keep the current center */
                        }
                    });

                // --- gas top-up via devstack's fork faucet -----------------------
                const faucet = deps.sui.fundingFaucetStrategy;
                const maybeRefillGas = Effect.gen(function* () {
                    const balance = yield* Effect.promise(() =>
                        core
                            .getObject({ objectId: gasRef.objectId, include: { content: true } })
                            .then((r) => coinBalanceFromContent(r.object?.content))
                            .catch(() => 0n),
                    );
                    if (balance >= GAS_LOW_WATER_MIST) return;
                    if (faucet === null) {
                        stats.lastError = `gas low (${balance} MIST) and no fork faucet strategy — the sim will stop when dry`;
                        return;
                    }
                    yield* faucet.request({ address: WHALE, amount: GAS_REFILL_MIST }).pipe(
                        Effect.catch((cause) =>
                            Effect.sync(() => {
                                stats.lastError = `gas refill failed: ${String(cause).slice(0, 160)}`;
                            }),
                        ),
                    );
                    // The faucet transfers a NEW coin to the whale; fork-local
                    // objects ARE enumerable (unlike pre-fork mainnet state).
                    const owned = yield* Effect.promise(() =>
                        core.listOwnedObjects({ owner: WHALE }).catch(() => ({ objects: [] })),
                    );
                    const fresh = (owned.objects ?? []).find(
                        (o) =>
                            String(o.type ?? "").includes("::coin::Coin<") &&
                            String(o.type ?? "").includes("::sui::SUI") &&
                            !knownGasIds.has(o.objectId),
                    );
                    if (fresh) {
                        knownGasIds.add(fresh.objectId);
                        pendingGasTopUp = yield* getRef(fresh.objectId).pipe(
                            Effect.catch(() => Effect.succeed(null)),
                        );
                        stats.gasRefills += 1;
                    }
                });

                // --- the tick ---------------------------------------------------
                let tickCount = 0;
                const tick = Effect.gen(function* () {
                    tickCount += 1;
                    const pool = pools[tickCount % pools.length]!;

                    // TX A — reclaim, in its OWN transaction. When cleanup shares
                    // a tx with the order placement, an aborting bid reverts the
                    // cleanup too: the previous tick's straddle remnant and parked
                    // settlement credits stay stuck, and every later bid aborts
                    // EBalanceManagerBalanceTooLow (3) forever (observed live in
                    // all three earlier strategy variants). A committed reclaim
                    // makes any TX B failure recoverable on the next tick.
                    {
                        const txA = new Transaction();
                        const proofA = txA.moveCall({
                            target: `${pkg}::balance_manager::generate_proof_as_owner`,
                            arguments: [bmRef(txA)],
                        });
                        const poolA = txA.sharedObjectRef({
                            objectId: pool.pin.objectId,
                            initialSharedVersion: pool.pin.initialSharedVersion,
                            mutable: true,
                        });
                        txA.moveCall({
                            target: `${pkg}::pool::cancel_all_orders`,
                            arguments: [poolA, bmRef(txA), proofA, txA.object.clock()],
                            typeArguments: [pool.pin.baseType, pool.pin.quoteType],
                        });
                        txA.moveCall({
                            target: `${pkg}::pool::withdraw_settled_amounts`,
                            arguments: [poolA, bmRef(txA), proofA],
                            typeArguments: [pool.pin.baseType, pool.pin.quoteType],
                        });
                        const rawA = yield* impersonate(
                            txA,
                            WHALE,
                            takeGasPayment(),
                            `${pool.name} reclaim`,
                        );
                        gasRef = refreshedRef(rawA, gasRef);
                    }

                    // bounded random walk: ±1 tick per fill, clamped to ±10.
                    const step = Math.random() < 0.5 ? -1n : 1n;
                    pool.walkTicks = BigInt(
                        Math.max(-10, Math.min(10, Number(pool.walkTicks + step))),
                    );
                    // qty jitter 80–110%, lot-aligned — must stay INSIDE the 115%
                    // one-time funding headroom or fills abort on balance.
                    const lot = BigInt(pool.pin.lotSize);
                    const jittered =
                        (pool.qty * BigInt(80 + Math.floor(Math.random() * 31))) / 100n;
                    let qty = jittered >= lot ? (jittered / lot) * lot : lot;

                    // Direction by inventory: above the funded base target ⇒ sell;
                    // else buy. Cycling keeps both legs solvent indefinitely.
                    const baseBal = yield* bmBalance(pool.pin.baseType);
                    const sell = baseBal > pool.targetBase;
                    // Straddle center X (walked); pair rests at X∓2, IOC crosses
                    // to the matching edge.
                    const xTicks = pool.centerTicks + pool.walkTicks;
                    const bidTicks = xTicks - 2n > 1n ? xTicks - 2n : 1n;
                    const askTicks = xTicks + 2n;
                    const iocTicks = sell ? bidTicks : askTicks;

                    // TX B — the straddle + IOC (may abort; state stays clean).
                    const tx = new Transaction();
                    const proof = tx.moveCall({
                        target: `${pkg}::balance_manager::generate_proof_as_owner`,
                        arguments: [bmRef(tx)],
                    });
                    const poolShared = tx.sharedObjectRef({
                        objectId: pool.pin.objectId,
                        initialSharedVersion: pool.pin.initialSharedVersion,
                        mutable: true,
                    });
                    const order = (isBid: boolean, orderType: number, ticks: bigint, q: bigint) => {
                        pool.clientOrderId += 1n;
                        tx.moveCall({
                            target: `${pkg}::pool::place_limit_order`,
                            arguments: [
                                poolShared,
                                bmRef(tx),
                                proof,
                                tx.pure.u64(pool.clientOrderId),
                                tx.pure.u8(orderType),
                                tx.pure.u8(0), // SELF_MATCHING_ALLOWED
                                tx.pure.u64(ticks * pool.tick),
                                tx.pure.u64(q),
                                tx.pure.bool(isBid),
                                tx.pure.bool(false), // fees in input token (zero: whitelisted)
                                tx.pure.u64(MAX_TIMESTAMP),
                                tx.object.clock(),
                            ],
                            typeArguments: [pool.pin.baseType, pool.pin.quoteType],
                        });
                    };
                    order(true, 0, bidTicks, qty); // resting straddle bid @ X-2
                    order(false, 0, askTicks, qty); // resting straddle ask @ X+2
                    order(!sell, 1, iocTicks, qty); // IOC into our own straddle edge

                    const raw = yield* impersonate(
                        tx,
                        WHALE,
                        takeGasPayment(),
                        `${pool.name} fill`,
                    );
                    gasRef = refreshedRef(raw, gasRef);
                    stats.fills += 1;
                    stats.consecutiveFailures = 0;

                    // Clock: chase wall time, forward-only, never past it.
                    const room = Date.now() - chainClock;
                    const advance = Math.max(1, Math.min(room, intervalMs * 3));
                    yield* fork.advanceClock(advance);
                    chainClock += advance;
                    // Correct local drift from the source periodically.
                    if (tickCount % 100 === 0) {
                        const s = yield* fork.status;
                        chainClock = s.clock;
                    }
                    if (tickCount % GAS_CHECK_EVERY === 0) {
                        yield* maybeRefillGas;
                    }
                    // Track the real book: recenter the walk on the last fill.
                    if (tickCount % 40 === 0) {
                        yield* recenter(pool);
                    }
                }).pipe(
                    Effect.catch((cause) =>
                        Effect.sync(() => {
                            stats.failures += 1;
                            stats.consecutiveFailures += 1;
                            stats.lastError = String(
                                (cause as { message?: string }).message ?? cause,
                            ).slice(0, 300);
                            if (
                                stats.consecutiveFailures === 1 ||
                                stats.consecutiveFailures % 25 === 0
                            ) {
                                console.error(
                                    `[trade-sim] fill failed (${stats.consecutiveFailures} consecutive): ${stats.lastError}`,
                                );
                            }
                        }),
                    ),
                );

                // --- OHLCV aggregation (production's pg_cron stand-in) ----------
                let ohlcvRuns = 0;
                const aggregate = Effect.gen(function* () {
                    ohlcvRuns += 1;
                    const now = Date.now();
                    const psql = (sql: string) =>
                        runtime.exec(deps.postgres.handle, [
                            "psql",
                            "-U",
                            deps.postgres.user,
                            "-d",
                            deps.postgres.database,
                            "-c",
                            sql,
                        ]);
                    yield* psql(`CALL update_ohclv_1m(${now - 900_000}, ${now + 60_000})`);
                    if (ohlcvRuns % 8 === 0) {
                        yield* psql(`CALL update_ohclv_1d(${now - 172_800_000}, ${now + 60_000})`);
                    }
                }).pipe(
                    Effect.catch((cause) =>
                        Effect.sync(() => {
                            stats.lastError = `ohlcv aggregation failed: ${String(cause).slice(0, 160)}`;
                        }),
                    ),
                );

                // Long-lived loops die with the plugin scope (devstack auto-tick's
                // pattern: repeat on a spaced schedule, failures already swallowed
                // per-iteration above).
                yield* Effect.forkScoped(
                    Effect.repeat(tick, Schedule.spaced(Duration.millis(intervalMs))),
                );
                yield* Effect.forkScoped(
                    Effect.repeat(aggregate, Schedule.spaced(Duration.millis(ohlcvMs))),
                );

                return {
                    enabled: true as const,
                    pools: poolNames,
                    intervalMs,
                    ohlcvMs,
                    balanceManager: bmFinal.objectId,
                    stats,
                };
            }),
    });
}

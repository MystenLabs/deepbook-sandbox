// Continuous trade simulator as a devstack member — keeps the dashboard's
// DeepBook Price panel and /ticker live by self-filling orders on the fork
// every SIM_INTERVAL_MS (default 600ms).
//
// The pair sits STRICTLY INSIDE the measured real spread (SEDEFI-455).
// Earlier versions guessed the center from pin-era USD mids; the guess sat
// above the real best ask (2341 vs 2338 ticks on DEEP_SUI), so every
// "resting" bid executed as a taker and market-bought base until the
// manager's quote was gone — first fills, then EBalanceManagerBalanceTooLow
// (3) on every later tick, forever: the sell leg that would convert base
// back sits AFTER the aborting bid in the same PTB, so it can never run.
// The touch is now read straight off the book (BigVector descent, ~6
// getObjects) at boot, every MEASURE_EVERY ticks, and on failure streaks —
// measured, never guessed, and no probe trades.
//
// Mechanism (the one-shot backfill sibling is scripts/seed-trades.ts; the
// primitives are ported from it and from deep-funding.ts):
//   - Impersonated execution via `deps.sui.fork.impersonate` (empty-sig, gRPC
//     ForkingService) — no signing, no docker exec. Sender is the DEEP whale.
//   - TWO txs per tick. TX A: cancel_all_orders + withdraw_settled_amounts —
//     reclaim in its own always-committing tx (cleanup sharing a tx with the
//     orders means an aborting bid reverts the cleanup too, wedging the
//     manager permanently — observed live in three earlier variants). TX B:
//     an ADJACENT resting pair on the interior ticks of the measured spread
//     (`interiorPair`) + ONE IOC that crosses INTO our own pair. All three
//     legs share one atomic PTB, so the IOC always finds our fresh maker:
//     the bid sits strictly above the real best bid and the ask strictly
//     below the real best ask, which makes ours first by price priority AND
//     keeps every leg from executing against the pin-era book. A 2-tick
//     spread collapses the pair onto its single interior tick (the ask then
//     self-fills the resting bid at placement); a ≤1-tick spread skips the
//     tick entirely.
//   - IOC direction: alternates for price variety while base inventory is
//     within ±2 fills of its post-funding level; outside that band (an
//     external taker ate one side) it trades back toward the level.
//   - Failure streaks re-measure the touch and re-run shortfall funding on
//     the next tick — a moved touch or a drained leg heals without a stack
//     restart.
//   - Default pool DEEP_SUI only: it is whitelisted (zero input-token fees),
//     so cycling leaks nothing. SIM_POOLS extends it; non-whitelisted pools
//     leak fees per fill and will eventually drain the manager.
//   - Reading the touch doubles as the fork pre-warm for the exact slices
//     the pair inserts into (SUI-FORK-ISSUES #2: execution child reads
//     don't lazy-fetch) — it subsumes the old pool-inner-only pre-warm, and
//     an interior pair never walks the book past the touch.
//   - Clock: fills are only visible to the server's wall-relative windows if
//     checkpoint timestamps track wall time (SUI-FORK-ISSUES #6). The
//     clock-driver member (SEDEFI-317) holds the Clock at wall time for the
//     whole stack; this loop only does a one-shot catch-up at boot, so its
//     first fills are visible even if it wins the race with the driver.
//   - OHLCV: `ohclv_1m/1d` are plain tables production fills via pg_cron
//     (absent in postgres:16-alpine) — a second loop CALLs update_ohclv_*
//     through the postgres member's container handle every few seconds.
//
// Chart expectations: /ohclv has no interval below 1m, so the Price panel
// grows ONE new point per minute; sub-minute fills update the current
// candle's close and the /ticker last price — that is the "live" feel.
//
// Gas: the whale's pinned SUI coin is small (~4 SUI). The loop tracks the gas
// coin's version from tx effects (no per-tick re-read), declares a budget
// capped to the coin's last-known balance, and when it runs low tops the
// whale up from the impersonated SUI donor (suiGrantViaWhale — devstack's
// fork faucet strategy is structurally null on a fork), merging the fresh
// coin into the gas coin as a second gas payment on the next tx.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
import {
    MIN_FORK_GAS_BUDGET,
    suiGrantViaWhale,
    type FullCore as GrantCore,
} from "./fork-sui-grant.ts";
import type { indexerMember } from "./indexer-member.ts";
import type { poolsSeedMember } from "./pools-seed.ts";
import type { postgresMember } from "./postgres-member.ts";
import type { registryInitMember } from "./registry-init.ts";

const MEMBER = "trade-sim";
const fail = memberError(MEMBER);

/** Opt-in heartbeat tap (SIM_HEARTBEAT_PATH=/some/file): one line per tick
 *  stage, appendFileSync so it survives the supervisor swallowing Effect
 *  logs. The sim's worst failure mode is a SILENTLY dead or hung tick fiber
 *  (a defect kills the repeat loop without any status change; an un-timed
 *  await parks it forever) — this is the instrument that finds where. */
const HEARTBEAT_PATH = process.env.SIM_HEARTBEAT_PATH?.trim() || null;
const beat = (msg: string): void => {
    if (HEARTBEAT_PATH === null) return;
    try {
        appendFileSync(HEARTBEAT_PATH, `${new Date().toISOString()} ${msg}\n`);
    } catch {
        /* a broken tap must never break the sim */
    }
};

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

/** Ceiling, not a constant. Sui rejects any tx whose gas coin holds LESS than
 *  the declared budget, before execution — so once the whale's SUI coin dips
 *  under this, EVERY sim tx is refused and the error arrives thrown (not as a
 *  FailedTransaction), which is how a broke sim used to look like a mystery
 *  `reclaim: [object Object]` loop. The budget is capped to the coin's actual
 *  balance (`gasBudgetFor`), the same fix already applied to dashboard writes,
 *  DEEP/USDC funding and the faucet. */
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
/** Ticks between steady-state touch re-measurements (~6 getObjects each) —
 *  tracks a touch that dashboard users move between failure streaks. */
const MEASURE_EVERY = 40;
/** Pin-era oracle mids — only the EMPTY-BOOK fallback center now; a measured
 *  touch overrides them. (Live Pyth reads are deliberately not a dependency:
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
    // NOTE: no listOwnedObjects here on purpose — that surface can hang
    // FOREVER on the fork (SUI-FORK-ISSUES #11); nothing in the sim may
    // depend on enumeration.
};

const coinSymbol = (coinType: string): string => coinType.split("::").pop() ?? coinType;

/** Build empty-sig impersonation bytes — offline, concrete refs only (the
 *  fork has no simulate_transaction; an unresolved input means a build bug). */
const buildImpersonationBytes = async (
    tx: Transaction,
    sender: string,
    gas: readonly ObjectRef[],
    budget: bigint,
): Promise<Uint8Array> => {
    tx.setSender(sender);
    tx.setGasBudget(budget);
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

/**
 * Human-readable text for a thrown/failed cause.
 *
 * `String(cause)` yields "[object Object]" for the tagged, non-Error shapes
 * devstack and the fork RPC reject with — which is exactly what this loop
 * logged 7000+ times while the real message ("Balance of gas object N is lower
 * than the needed amount") sat one property away. Reverts print fine
 * (`revertReason` below); this covers everything that fails BEFORE execution.
 */
const describeCause = (cause: unknown): string => {
    if (cause == null) return "unknown error";
    if (typeof cause === "string") return cause;
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    if (cause instanceof Error) return cause.message || cause.name;
    try {
        return JSON.stringify(cause, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(
            0,
            300,
        );
    } catch {
        return Object.prototype.toString.call(cause);
    }
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

/** The fork's execution envelope for one impersonated tx. */
type ImpersonationOutcome = {
    readonly digest: string;
    readonly success: boolean;
    readonly raw: unknown;
};

/** Attempts for one impersonated tx: the first, plus retries after a
 *  stale-ref refresh. Three covers the trading-dashboard member's boot burst
 *  (a DEEP grant and a USDC grant, back to back on the shared gas coin). */
const STALE_REF_ATTEMPTS = 3;

/**
 * Does this PRE-EXECUTION rejection mean "a ref you passed is no longer
 * current"?
 *
 * The whale's gas coin is not ours alone: deep-funding, usdc-funding and the
 * faucet all pay gas with the SAME pinned coin, so any of them can bump it
 * between our last read and our execute. Boot is where it bites — the
 * trading-dashboard member tops its dev wallet up with DEEP and USDC (both
 * gas-paid by that coin) while this loop is placing its own first
 * transactions, and a lost race there fails the member, and with it the whole
 * `devstack up`.
 *
 * The fork resolves an owned input BY ID and tolerates a stale version, so a
 * mismatched digest is the only symptom that actually surfaces (verified
 * against a live fork: a stale version+digest pair is accepted; a current
 * version with a stale digest is rejected exactly like this). The sibling
 * "not available for consumption" covers the version-checked inputs — the
 * BalanceManager and the DEEP source coin.
 *
 * The message arrives URL-encoded through the gRPC layer
 * ("Invalid%20Object%20digest"), so match the decoded form as well as the raw.
 */
export const isStaleRefError = (cause: unknown): boolean => {
    const raw = describeCause(cause);
    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        // a lone '%' in the message — the raw form is still matched below.
    }
    const stale = /Invalid Object digest|not available for consumption/i;
    return stale.test(decoded) || stale.test(raw);
};

/** Coin<SUI> balance from a Coin object's BCS content (u64 LE after the UID). */
const coinBalanceFromContent = (content: Uint8Array | undefined): bigint => {
    if (!content || content.length < 40) return 0n;
    return new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true);
};

/* ---- order-book touch reading (SEDEFI-455) ------------------------------- */

const u64le = (b: Uint8Array, off: number): bigint =>
    new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, true);
const u128le = (b: Uint8Array, off: number): bigint => u64le(b, off) + (u64le(b, off + 8) << 64n);

/** Minimal ULEB128 decode (BCS vector lengths). */
const readUleb = (b: Uint8Array, off: number): { value: number; size: number } => {
    let value = 0;
    let shift = 0;
    let size = 0;
    for (;;) {
        const byte = b[off + size] ?? 0;
        size += 1;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value, size };
};

/** BigVector<E> header: UID(32) + depth u8 + length / max_slice_size /
 *  max_fan_out / root_id / last_id (5 × u64) = 73 bytes. */
const BIG_VECTOR_BYTES = 73;
/** BigVector's "no root" sentinel. */
const NO_SLICE = (1n << 64n) - 1n;
/** Price bits of a DeepBook order-id key (bit 127 flags an ask). */
const ORDER_PRICE_MASK = (1n << 63n) - 1n;

type BookSide = { uid: string; depth: number; length: bigint; rootId: bigint };

const readBookSide = (b: Uint8Array, off: number): BookSide => ({
    uid: `0x${Buffer.from(b.slice(off, off + 32)).toString("hex")}`,
    depth: b[off + 32] ?? 0,
    length: u64le(b, off + 33),
    rootId: u64le(b, off + 57),
});

/**
 * Best bid and ask of a pool, in TICKS, read straight off the book.
 *
 * Descends each side's BigVector to its extreme leaf (rightmost for bids,
 * leftmost for asks) and decodes the order-id key's price bits — no
 * dev_inspect (fork-dead), no probe trades, ~6 getObjects at the books'
 * usual depth of 1. The reads double as the fork pre-warm for exactly the
 * slices the sim's orders insert into (SUI-FORK-ISSUES #2: execution child
 * reads don't lazy-fetch), subsuming the old pool-inner-only pre-warm.
 */
const readBookTouch = async (
    core: SimCore,
    poolId: string,
    tick: bigint,
): Promise<{ bestBidTicks: bigint | null; bestAskTicks: bigint | null }> => {
    const poolObj = await core.getObject({ objectId: poolId, include: { content: true } });
    const content = poolObj.object?.content;
    if (!content || content.length < 72) throw new Error(`pool ${poolId}: no content`);
    // Pool { id: UID(32), inner: Versioned { id: UID(32), version: u64 } }
    const innerFieldId = deriveDynamicFieldID(
        `0x${Buffer.from(content.slice(32, 64)).toString("hex")}`,
        "u64",
        bcs.u64().serialize(u64le(content, 64)).toBytes(),
    );
    const inner = await core.getObject({ objectId: innerFieldId, include: { content: true } });
    const ic = inner.object?.content;
    if (!ic) throw new Error(`pool ${poolId}: inner Versioned field has no content`);
    // Field hdr(40) + allowed_versions vector<u64> + pool_id(32)
    // + book{ tick_size, lot_size, min_size (3 × u64), bids, asks }
    let off = 40;
    const allowed = readUleb(ic, off);
    off += allowed.size + allowed.value * 8 + 32;
    const tickOnChain = u64le(ic, off);
    if (tickOnChain !== tick) {
        throw new Error(
            `pool ${poolId}: on-chain tick ${tickOnChain} != manifest ${tick} — ` +
                "book layout drift (package upgrade?)",
        );
    }
    off += 24;
    const bids = readBookSide(ic, off);
    const asks = readBookSide(ic, off + BIG_VECTOR_BYTES);

    // Descend to the extreme leaf; edge -1 = rightmost (max key = best bid),
    // 0 = leftmost (min key = best ask).
    const extremePrice = async (side: BookSide, edge: 0 | -1): Promise<bigint | null> => {
        if (side.length === 0n || side.rootId === NO_SLICE) return null;
        let sliceId = side.rootId;
        for (let d = 0; ; d++) {
            const fieldId = deriveDynamicFieldID(
                side.uid,
                "u64",
                bcs.u64().serialize(sliceId).toBytes(),
            );
            const res = await core.getObject({ objectId: fieldId, include: { content: true } });
            const sc = res.object?.content;
            if (!sc) throw new Error(`book slice ${sliceId} of ${poolId} has no content`);
            // Field hdr(40) + Slice.prev(8) + Slice.next(8) + keys vector<u128>
            // + vals (child slice ids on an interior node, Orders on a leaf).
            let so = 56;
            const keys = readUleb(sc, so);
            if (d === side.depth) {
                if (keys.value === 0) return null;
                const at = so + keys.size + (edge === 0 ? 0 : keys.value - 1) * 16;
                return (u128le(sc, at) >> 64n) & ORDER_PRICE_MASK;
            }
            so += keys.size + keys.value * 16;
            const vals = readUleb(sc, so);
            if (vals.value === 0) return null;
            so += vals.size;
            sliceId = u64le(sc, so + (edge === 0 ? 0 : vals.value - 1) * 8);
        }
    };

    const bestBid = await extremePrice(bids, -1);
    const bestAsk = await extremePrice(asks, 0);
    return {
        bestBidTicks: bestBid === null ? null : bestBid / tick,
        bestAskTicks: bestAsk === null ? null : bestAsk / tick,
    };
};

/**
 * Where the self-fill pair may sit, in ticks, given the measured touch.
 *
 * The pair must rest STRICTLY inside the spread: the bid above the real best
 * bid (so the sell IOC meets ours first by price priority) and the ask below
 * the real best ask (ditto for the buy IOC) — then no leg can ever execute
 * against the pin-era book. `xTicks` (the walked center) picks WHERE in a
 * wide interior the pair sits; tight interiors clamp it. Returns null when
 * the spread has no interior at all (≤ 1 tick) — skip the tick. On a 2-tick
 * spread the pair collapses onto the single interior tick: the ask placed
 * second self-fills the resting bid at placement (SELF_MATCHING_ALLOWED),
 * which is a legitimate fill, and the IOC then expires unfilled.
 */
export const interiorPair = (
    bestBidTicks: bigint | null,
    bestAskTicks: bigint | null,
    xTicks: bigint,
): { bid: bigint; ask: bigint } | null => {
    const lo = bestBidTicks === null ? null : bestBidTicks + 1n;
    const hi = bestAskTicks === null ? null : bestAskTicks - 1n;
    const clamp = (v: bigint, min: bigint, max: bigint): bigint => {
        if (v < min) return min;
        if (v > max) return max;
        return v;
    };
    if (lo !== null && hi !== null) {
        if (hi < lo) return null;
        if (hi === lo) return { bid: lo, ask: lo };
        const bid = clamp(xTicks - 1n, lo, hi - 1n);
        return { bid, ask: bid + 1n };
    }
    if (hi !== null) {
        // No real bids: the ask side and price > 0 constrain us.
        if (hi < 2n) return null;
        const bid = clamp(xTicks - 1n, 1n, hi - 1n);
        return { bid, ask: bid + 1n };
    }
    if (lo !== null) {
        // No real asks: only the bid side constrains us.
        const bid = xTicks - 1n > lo ? xTicks - 1n : lo;
        return { bid, ask: bid + 1n };
    }
    // Empty book: nothing to cross — keep the walked shape.
    const bid = xTicks - 2n > 1n ? xTicks - 2n : 1n;
    const ask = xTicks + 2n > bid ? xTicks + 2n : bid + 1n;
    return { bid, ask };
};

export type TradeSimOptions = {
    sui: ReturnType<typeof sui>;
    postgres: ReturnType<typeof postgresMember>;
    /** ordering only: fills need the pools config + a live ingestion path. */
    poolsSeed: ReturnType<typeof poolsSeedMember>;
    indexer: ReturnType<typeof indexerMember>;
    /** ordering only: the sim's boot-time clock catch-up must NOT be a fresh
     *  chain's first commit (SUI-FORK-ISSUES #9) — registry-init lands the
     *  framework pre-warm and the first real txs before it. */
    registryInit: ReturnType<typeof registryInitMember>;
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
            registryInit: opts.registryInit,
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
                    /** ticks skipped because the spread had no interior. */
                    skips: 0,
                    /** touch re-measurements (boot + periodic + recovery). */
                    remeasures: 0,
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

                /** Re-read a gas payment from chain and re-track the gas coin.
                 *  Only ever called after a stale-ref rejection — the happy
                 *  path still advances `gasRef` from tx effects, so this costs
                 *  nothing per tick. */
                const refreshPayment = (
                    payment: readonly ObjectRef[],
                ): Effect.Effect<ObjectRef[], unknown> =>
                    Effect.gen(function* () {
                        const fresh: ObjectRef[] = [];
                        for (const ref of payment) {
                            const next = yield* getRef(ref.objectId);
                            if (next.objectId === WHALE_GAS_COIN) gasRef = next;
                            fresh.push(next);
                        }
                        return fresh;
                    });

                const impersonateOnce = (
                    tx: Transaction,
                    sender: string,
                    gas: readonly ObjectRef[],
                    label: string,
                ): Effect.Effect<ImpersonationOutcome, unknown> =>
                    Effect.gen(function* () {
                        const bytes = yield* Effect.tryPromise({
                            try: () => buildImpersonationBytes(tx, sender, gas, gasBudgetFor()),
                            catch: (cause) =>
                                fail("build-tx", `${label}: ${describeCause(cause)}`, cause),
                        });
                        return yield* fork.impersonate(sender, bytes);
                    });

                /** A rejected ref is not a dead end: another member spending
                 *  the shared whale gas coin invalidates ours (isStaleRefError),
                 *  and a re-read makes the very same tx land. */
                const impersonateRetrying = (
                    tx: Transaction,
                    sender: string,
                    gas: readonly ObjectRef[],
                    label: string,
                    attemptsLeft: number,
                ): Effect.Effect<ImpersonationOutcome, unknown> =>
                    impersonateOnce(tx, sender, gas, label).pipe(
                        Effect.catch((cause) => {
                            if (attemptsLeft > 1 && isStaleRefError(cause)) {
                                beat(`${label}: stale ref, refreshing gas and retrying`);
                                return refreshPayment(gas).pipe(
                                    Effect.flatMap((fresh) =>
                                        impersonateRetrying(
                                            tx,
                                            sender,
                                            fresh,
                                            label,
                                            attemptsLeft - 1,
                                        ),
                                    ),
                                );
                            }
                            return Effect.fail(
                                (cause as { _tag?: string })?._tag === "ForkStackMemberError"
                                    ? cause
                                    : fail("execute", `${label}: ${describeCause(cause)}`, cause),
                            );
                        }),
                    );

                const impersonate = (
                    tx: Transaction,
                    sender: string,
                    gas: readonly ObjectRef[],
                    label: string,
                ): Effect.Effect<unknown, unknown> =>
                    Effect.gen(function* () {
                        const result = yield* impersonateRetrying(
                            tx,
                            sender,
                            gas,
                            label,
                            STALE_REF_ATTEMPTS,
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
                // the server's wall-relative windows. Forward-only, never past
                // wall. STEADY-STATE clock movement is the clock-driver
                // member's job (SEDEFI-317); this one-shot only covers the sim
                // booting before the driver's own catch-up lands, and keeps the
                // sim usable under CLOCK_DRIVER_DISABLED=1.
                const status = yield* fork.status.pipe(
                    Effect.catch((cause) =>
                        Effect.fail(fail("status", "fork status read failed", cause)),
                    ),
                );
                const catchUp = Date.now() - status.clock;
                if (catchUp > 0) {
                    yield* fork
                        .advanceClock(catchUp)
                        .pipe(
                            Effect.catch((cause) =>
                                Effect.fail(fail("clock", "initial clock catch-up failed", cause)),
                            ),
                        );
                }

                // --- gas coin (version tracked from effects after each tx) ------
                let gasRef = yield* getRef(WHALE_GAS_COIN);
                /** faucet-funded coin waiting to be merged into the gas coin. */
                let pendingGasTopUp: ObjectRef | null = null;
                /** Last observed balance of the gas coin, refreshed on every gas
                 *  check and after every top-up. Only ever used to LOWER the
                 *  declared budget, so staleness cannot cause a rejection. */
                let gasBalance = yield* Effect.promise(() =>
                    core
                        .getObject({ objectId: gasRef.objectId, include: { content: true } })
                        .then((r) => coinBalanceFromContent(r.object?.content))
                        .catch(() => 0n),
                );
                /** Declared budget for the next tx: the ceiling, or the coin's
                 *  balance when that is smaller (a budget above the balance is
                 *  refused pre-execution). */
                const gasBudgetFor = (): bigint =>
                    gasBalance > 0n && gasBalance < GAS_BUDGET ? gasBalance : GAS_BUDGET;

                // (The old boot-time faucet top-up is gone: devstack's fork
                // faucet strategy is structurally null on a fork, so the block
                // never ran — and its ListOwnedObjects discovery is the exact
                // call that can hang forever, SUI-FORK-ISSUES #11. Gas refills
                // now come solely from maybeRefillGas below, which runs on the
                // FIRST tick.)

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

                // --- per-pool setup: measure the touch + boot funding -----------
                type PoolState = {
                    name: string;
                    pin: (typeof ids.pools)[string];
                    qty: bigint;
                    tick: bigint;
                    centerTicks: bigint;
                    walkTicks: bigint;
                    clientOrderId: bigint;
                    /** post-funding base inventory — the level the IOC
                     *  direction steers back toward when knocked off it. */
                    targetBase: bigint;
                    /** measured touch (ticks); a null side is an empty side. */
                    bestBidTicks: bigint | null;
                    bestAskTicks: bigint | null;
                    /** per-pool IOC alternator (tick parity breaks under the
                     *  multi-pool round-robin). */
                    flip: boolean;
                };

                /** (Re-)measure a pool's touch and recenter the walk on its
                 *  midpoint. Boot treats a failure as fatal (placing without a
                 *  measurement is how the sim used to market-buy its own quote
                 *  away); steady state swallows it and keeps the last read. */
                const measure = (pool: PoolState): Effect.Effect<void, unknown> =>
                    Effect.tryPromise({
                        try: () => readBookTouch(core, pool.pin.objectId, pool.tick),
                        catch: (cause) =>
                            fail(
                                "book",
                                `${pool.name}: touch read failed: ${describeCause(cause)}`,
                                cause,
                            ),
                    }).pipe(
                        Effect.map((touch) => {
                            pool.bestBidTicks = touch.bestBidTicks;
                            pool.bestAskTicks = touch.bestAskTicks;
                            stats.remeasures += 1;
                            if (touch.bestBidTicks !== null && touch.bestAskTicks !== null) {
                                pool.centerTicks = (touch.bestBidTicks + touch.bestAskTicks) / 2n;
                            }
                        }),
                    );

                /** Deposit whatever the manager is short of the 3× working
                 *  amounts (the pair + IOC lock ≈ 2× each side concurrently).
                 *  Quote need prices qty at the current center in raw book
                 *  units (quote = base × price / 10^9). Runs at boot and on
                 *  failure-streak recovery, so a drained leg heals without a
                 *  stack restart. */
                const topUpBalances = (pool: PoolState): Effect.Effect<void, unknown> =>
                    Effect.gen(function* () {
                        const needs = new Map<string, bigint>();
                        needs.set(pool.pin.baseType, pool.qty * 3n);
                        needs.set(
                            pool.pin.quoteType,
                            (pool.qty * pool.centerTicks * pool.tick * 3n) / 1_000_000_000n,
                        );
                        let deposited = false;
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
                                // USDC needs the mint flow — keep the always-on
                                // sim to DEEP/SUI pools; seed-trades covers USDC
                                // pools one-shot.
                                return yield* Effect.fail(
                                    fail(
                                        "funding",
                                        `pool ${pool.name} needs ${sym} funding — the sim only ` +
                                            "self-funds SUI/DEEP (run scripts/seed-trades.ts for " +
                                            "USDC pools, or extend the sim)",
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
                            deposited = true;
                        }
                        // A SUI deposit spends from the gas coin itself — re-read
                        // the balance so the declared-budget cap stays honest.
                        if (deposited) {
                            gasBalance = yield* Effect.promise(() =>
                                core
                                    .getObject({
                                        objectId: gasRef.objectId,
                                        include: { content: true },
                                    })
                                    .then((r) => coinBalanceFromContent(r.object?.content))
                                    .catch(() => gasBalance),
                            );
                        }
                    });

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
                    // Fallback center for an EMPTY book, from pin-era USD mids;
                    // a measured touch overrides it. SIM_TICK_BIAS nudges only
                    // this fallback — same knob seed-trades has.
                    const centerTicks =
                        BigInt(Math.round((mid * Number(priceMult)) / Number(tick))) +
                        BigInt(process.env.SIM_TICK_BIAS ?? 0);

                    const pool: PoolState = {
                        name,
                        pin,
                        qty,
                        tick,
                        centerTicks,
                        walkTicks: 0n,
                        clientOrderId: BigInt(Date.now()) * 1000n,
                        targetBase: 0n, // set below, after funding
                        bestBidTicks: null,
                        bestAskTicks: null,
                        flip: false,
                    };

                    // Measure the touch — fatal at boot, and it doubles as the
                    // pre-warm of the pool inner + touch slices the orders walk
                    // (SUI-FORK-ISSUES #2 / SEDEFI-448).
                    yield* measure(pool);

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

                    // Re-measure now that OUR leftovers are out of the book: a
                    // previous run's pair sat inside the spread, and measuring
                    // it as foreign would needlessly shrink (even empty) the
                    // interior for the first MEASURE_EVERY ticks.
                    yield* measure(pool);

                    // Boot funding to the 3× working amounts — the whitelisted
                    // (zero-fee) interior cycle then leaks nothing.
                    yield* topUpBalances(pool);
                    // The steering level is the POST-funding inventory, not a
                    // formula: a reused manager can sit far above any formula
                    // (e.g. after the old crossing bug converted its quote to
                    // base) and must not be locked into permanent one-way
                    // selling by that history.
                    pool.targetBase = yield* bmBalance(pin.baseType);
                    pools.push(pool);
                }

                // --- gas top-up -------------------------------------------------
                // Grants come from the impersonated SUI donor (suiGrantViaWhale):
                // devstack's fork faucet strategy is STRUCTURALLY null here (it
                // vets its whale with the index-backed listCoins, empty on a
                // fork — see fork-sui-grant.ts), so the old faucet-only path
                // never fired even once and the sim just ran dry. The grant
                // resolves to the created coin's id straight from its own tx
                // effects — the ListOwnedObjects discovery this used to do is
                // the call that parked this fiber FOREVER, twice, with zero
                // errors (SUI-FORK-ISSUES #11).
                const grantCore = deps.sui.sdk.client.core as unknown as GrantCore;
                const maybeRefillGas = Effect.gen(function* () {
                    beat("gas-check enter");
                    const balance = yield* Effect.promise(() =>
                        core
                            .getObject({ objectId: gasRef.objectId, include: { content: true } })
                            .then((r) => coinBalanceFromContent(r.object?.content))
                            .catch(() => 0n),
                    );
                    gasBalance = balance;
                    beat(`gas-check balance ${balance}`);
                    if (balance >= GAS_LOW_WATER_MIST) return;
                    if (balance < MIN_FORK_GAS_BUDGET) {
                        console.error(
                            `[trade-sim] gas coin down to ${balance} MIST — below the ` +
                                `${MIN_FORK_GAS_BUDGET} floor; topping up from the donor`,
                        );
                    }
                    const granted = yield* Effect.tryPromise({
                        try: () => suiGrantViaWhale(grantCore, WHALE, GAS_REFILL_MIST),
                        catch: (cause) => cause,
                    }).pipe(
                        Effect.catch((cause) =>
                            Effect.sync((): string | null => {
                                stats.lastError = `gas refill failed: ${describeCause(cause).slice(0, 160)}`;
                                return null;
                            }),
                        ),
                    );
                    beat(`gas-check granted ${granted}`);
                    if (granted === null) return;
                    const fresh = yield* getRef(granted).pipe(
                        Effect.catch(() => Effect.succeed(null)),
                    );
                    if (fresh !== null) {
                        // The coin merges into the gas payment on the next tx;
                        // credit it now so the budget cap lifts immediately
                        // rather than after the next balance read.
                        pendingGasTopUp = fresh;
                        gasBalance += GAS_REFILL_MIST;
                        stats.gasRefills += 1;
                    }
                });

                // --- the tick ---------------------------------------------------
                let tickCount = 0;
                /** Set by the failure path: the next tick re-measures the touch
                 *  and re-runs shortfall funding before placing. */
                let recoverPending = false;
                const tick = Effect.gen(function* () {
                    tickCount += 1;
                    const pool = pools[tickCount % pools.length]!;
                    beat(`tick ${tickCount} start`);

                    // Gas check FIRST, and unconditionally. It used to live at
                    // the end of the success path, which deadlocks the moment
                    // gas is the thing that broke: no gas -> no fill -> the
                    // check never runs -> no refill -> no gas. That is how the
                    // sim reached 9000+ consecutive failures with a refill
                    // routine that had never once executed.
                    if (tickCount % GAS_CHECK_EVERY === 1) {
                        yield* maybeRefillGas;
                    }

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
                    beat(`tick ${tickCount} reclaimed`);

                    // Recovery / periodic re-measure — AFTER the committed
                    // reclaim (so funding sees settled balances), BEFORE
                    // placement (so the pair uses fresh bounds).
                    if (recoverPending) {
                        recoverPending = false;
                        yield* measure(pool).pipe(Effect.catch(() => Effect.void));
                        yield* topUpBalances(pool);
                    } else if (tickCount % MEASURE_EVERY === 0) {
                        // Track a touch that users move; a failed read keeps the
                        // last measurement.
                        yield* measure(pool).pipe(Effect.catch(() => Effect.void));
                    }
                    beat(`tick ${tickCount} measured ${pool.bestBidTicks}/${pool.bestAskTicks}`);

                    // bounded random walk: ±1 tick per fill, clamped to ±10 —
                    // picks WHERE inside a wide interior the pair sits.
                    const step = Math.random() < 0.5 ? -1n : 1n;
                    pool.walkTicks = BigInt(
                        Math.max(-10, Math.min(10, Number(pool.walkTicks + step))),
                    );
                    // qty jitter 80–110%, lot-aligned — must stay INSIDE the 3×
                    // funding headroom or fills abort on balance.
                    const lot = BigInt(pool.pin.lotSize);
                    const jittered =
                        (pool.qty * BigInt(80 + Math.floor(Math.random() * 31))) / 100n;
                    let qty = jittered >= lot ? (jittered / lot) * lot : lot;

                    // The pair, strictly inside the measured spread.
                    const pair = interiorPair(
                        pool.bestBidTicks,
                        pool.bestAskTicks,
                        pool.centerTicks + pool.walkTicks,
                    );
                    if (pair === null) {
                        // No interior to sit in (≤1-tick spread) — placing
                        // anything would execute against the real book.
                        stats.skips += 1;
                        if (stats.skips === 1 || stats.skips % 100 === 0) {
                            console.error(
                                `[trade-sim] ${pool.name}: spread too tight to sit inside ` +
                                    `(bid ${pool.bestBidTicks} / ask ${pool.bestAskTicks} ` +
                                    `ticks) — ${stats.skips} ticks skipped`,
                            );
                        }
                        return;
                    }

                    // IOC direction: alternate inside the ±2-fill inventory band
                    // (price variety, zero net drift under self-fills); outside
                    // the band an external taker ate one side — trade back.
                    const baseBal = yield* bmBalance(pool.pin.baseType);
                    const drift = baseBal - pool.targetBase;
                    const band = pool.qty * 2n;
                    pool.flip = !pool.flip;
                    let sell = pool.flip;
                    if (drift > band) sell = true;
                    if (drift < -band) sell = false;

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
                    order(true, 0, pair.bid, qty); // rests above the real best bid
                    order(false, 0, pair.ask, qty); // rests below the real best ask
                    order(!sell, 1, sell ? pair.bid : pair.ask, qty); // IOC into our own pair

                    const raw = yield* impersonate(
                        tx,
                        WHALE,
                        takeGasPayment(),
                        `${pool.name} fill`,
                    );
                    gasRef = refreshedRef(raw, gasRef);
                    stats.fills += 1;
                    stats.consecutiveFailures = 0;
                    beat(
                        `tick ${tickCount} filled ${sell ? "sell" : "buy"} ${pair.bid}/${pair.ask}`,
                    );

                    // Clock: deliberately NOT advanced here — the clock-driver
                    // member owns it. This loop used to chase wall time off a
                    // LOCALLY tracked clock, which a second advancer makes
                    // stale: a low local read yields an oversized advance, and
                    // fills stamped past wall drop out of every server window
                    // until wall time catches up.
                }).pipe(
                    // A tick normally takes well under a second; fork gRPC calls
                    // can hang FOREVER (SUI-FORK-ISSUES #11), and a parked await
                    // kills the repeat loop with no error and no status change —
                    // the sim's worst failure mode. Bound the whole tick so a
                    // hang degrades into a counted failure + recovery instead.
                    // (An abandoned in-flight tx may still land — harmless: the
                    // next tick's reclaim re-baselines the manager.)
                    Effect.timeout(Duration.seconds(30)),
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
                                // A streak that survives one recovery retries a
                                // fresh measure + top-up as the streak grows.
                                recoverPending = true;
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
                    beat(`ohlcv ${ohlcvRuns}`);
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

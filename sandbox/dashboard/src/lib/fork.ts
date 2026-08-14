/**
 * Fork-mode read/write substitutes (SEDEFI-456).
 *
 * The mainnet fork the sandbox runs on does NOT support
 * `simulate_transaction` (SUI-FORK-ISSUES #7), which kills every
 * `@mysten/deepbook-v3` read helper (they all devInspect under the hood), and
 * it has no owner→coins/balance indexes for pre-fork state (fork-local
 * objects ARE enumerable via listOwnedObjects). This module provides the
 * replacements the trading hooks switch to in fork mode:
 *
 *   - balances: enumerate owned Coin<T> objects + parse BCS content
 *   - BM discovery/balances: derived dynamic-field reads (no simulation)
 *   - prices/open orders: the indexer-backed DeepBook server REST API
 *   - writes: explicit gas (budget/price/payment) so transaction building
 *     never needs a dry-run, plus a coinWithBalance-free deposit builder
 *
 * Everything here must stay browser-safe: no Buffer, no node imports.
 */

import { bcs } from "@mysten/sui/bcs";
import type { Transaction } from "@mysten/sui/transactions";
import { deriveDynamicFieldID, normalizeStructTag } from "@mysten/sui/utils";

export const FLOAT_SCALAR = 1_000_000_000;

/**
 * The package version that INTRODUCED `registry::BalanceManagerKey` — dynamic
 * field type tags carry a struct's DEFINING id, which for structs added in a
 * package upgrade is neither the original nor necessarily the latest id.
 * Recovered from a live register_balance_manager execution envelope
 * (SEDEFI-456); fixed mainnet state, like the DEEP treasury id.
 */
export const BALANCE_MANAGER_KEY_DEFINING_PKG =
    "0x00c1a56ec8c4c623a848b2ed2f03d23a25d17570b670c22106f336eb933785cc";

/** Matches devstack's fork-impersonation constants; a plain user tx just
 *  needs any budget that avoids the SDK's dry-run estimation path. Used as a
 *  CEILING — the effective budget is capped to what the sender actually holds
 *  (setForkGas). */
export const FORK_GAS_BUDGET = 100_000_000n; // 0.1 SUI
export const FORK_GAS_PRICE = 1_000n;

/**
 * Floor for the capped budget. Observed cost of the heaviest trading-page tx
 * (create + register + share a BalanceManager) is ~11.4M MIST charged, so
 * 0.02 SUI leaves ample headroom; below it we fail early with an actionable
 * message instead of letting the node reject the tx.
 */
export const FORK_GAS_MIN_BUDGET = 20_000_000n; // 0.02 SUI

/* ------------------------------------------------------------------ */
/*  Minimal client surface (the dapp-kit SuiGrpcClient's `core`)       */
/* ------------------------------------------------------------------ */

export interface ForkObjectRef {
    objectId: string;
    version: string;
    digest: string;
}

export interface ForkCore {
    getObject(args: { objectId: string; include?: { content?: boolean } }): Promise<{
        object?: {
            objectId: string;
            version: string;
            digest: string;
            type?: string;
            content?: Uint8Array;
        };
    }>;
    listOwnedObjects(args: {
        owner: string;
    }): Promise<{ objects?: { objectId: string; type?: string }[] }>;
}

/** The dapp-kit client exposes the standardized v2 surface at `.core`. */
export const coreOf = (client: unknown): ForkCore => (client as { core: ForkCore }).core;

const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Coin<T> balance from BCS content: u64 LE right after the 32-byte UID. */
const coinBalanceFromContent = (content: Uint8Array | undefined): bigint => {
    if (!content || content.length < 40) return 0n;
    return new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true);
};

/* ------------------------------------------------------------------ */
/*  Wallet balances (fork-local coins only — which is what a           */
/*  faucet-funded wallet holds)                                        */
/* ------------------------------------------------------------------ */

export interface OwnedCoin extends ForkObjectRef {
    coinType: string;
    balance: bigint;
}

/** All enumerable Coin<*> objects the owner holds, with balances. */
export async function listOwnedCoins(core: ForkCore, owner: string): Promise<OwnedCoin[]> {
    const owned = await core.listOwnedObjects({ owner });
    const coins: OwnedCoin[] = [];
    for (const o of owned.objects ?? []) {
        const type = String(o.type ?? "");
        const match = type.match(/::coin::Coin<(.+)>$/);
        if (!match) continue;
        const res = await core
            .getObject({ objectId: o.objectId, include: { content: true } })
            .catch(() => null);
        const obj = res?.object;
        if (!obj) continue;
        coins.push({
            objectId: obj.objectId,
            version: String(obj.version),
            digest: obj.digest,
            coinType: match[1],
            balance: coinBalanceFromContent(obj.content),
        });
    }
    return coins;
}

/* ------------------------------------------------------------------ */
/*  BalanceManager discovery — derived dynamic-field reads             */
/* ------------------------------------------------------------------ */

/**
 * `registry::get_balance_manager_ids` without simulation:
 *   registry UID --df--> BalanceManagerKey {} (DEFINING package id in the
 *   type tag; an empty Move struct is BCS [0]) = Field<_, Table<address,
 *   VecSet<ID>>> --content--> table UID --df--> owner address = Field<
 *   address, VecSet<ID>> --content--> the ids.
 *
 * Returns [] when the map or the owner's entry doesn't exist yet.
 */
export async function forkBalanceManagerIds(
    core: ForkCore,
    registryId: string,
    owner: string,
): Promise<string[]> {
    const mapFieldId = deriveDynamicFieldID(
        registryId,
        `${BALANCE_MANAGER_KEY_DEFINING_PKG}::registry::BalanceManagerKey`,
        new Uint8Array([0]),
    );
    const mapField = await core
        .getObject({ objectId: mapFieldId, include: { content: true } })
        .catch(() => null);
    const mapContent = mapField?.object?.content;
    // Field<BalanceManagerKey, Table>: UID(32) + dummy bool(1) + table UID(32) + size(8)
    if (!mapContent || mapContent.length < 73) return [];
    const tableUid = `0x${bytesToHex(mapContent.slice(33, 65))}`;

    const entryFieldId = deriveDynamicFieldID(
        tableUid,
        "address",
        bcs.Address.serialize(owner).toBytes(),
    );
    const entry = await core
        .getObject({ objectId: entryFieldId, include: { content: true } })
        .catch(() => null);
    const entryContent = entry?.object?.content;
    // Field<address, VecSet<ID>>: UID(32) + address(32) + vector<ID>
    if (!entryContent || entryContent.length < 65) return [];
    return bcs.vector(bcs.Address).parse(entryContent.slice(64));
}

/* ------------------------------------------------------------------ */
/*  BalanceManager balances — the manager's Bag, by derived field id   */
/* ------------------------------------------------------------------ */

/**
 * `balance_manager::balance<T>` without simulation. The manager's layout is
 * `{ id: UID, owner: address, balances: Bag, … }`, so the Bag UID sits at
 * content bytes 64..96; the per-coin entry is a `BalanceKey<T>` dynamic
 * field (ORIGINAL package id, BCS [0]) whose value is a bare u64 after the
 * field UID + dummy bool.
 */
export async function forkBmBalance(
    core: ForkCore,
    balanceManagerId: string,
    originalPackageId: string,
    coinType: string,
): Promise<bigint> {
    try {
        const bm = await core.getObject({
            objectId: balanceManagerId,
            include: { content: true },
        });
        const content = bm.object?.content;
        if (!content || content.length < 96) return 0n;
        const bagUid = `0x${bytesToHex(content.slice(64, 96))}`;
        const fieldId = deriveDynamicFieldID(
            bagUid,
            `${originalPackageId}::balance_manager::BalanceKey<${coinType}>`,
            new Uint8Array([0]),
        );
        const field = await core.getObject({ objectId: fieldId, include: { content: true } });
        const bytes = field.object?.content;
        // Field<BalanceKey<T>, u64>: UID(32) + dummy bool(1) + u64(8)
        if (!bytes || bytes.length < 41) return 0n;
        return new DataView(bytes.buffer, bytes.byteOffset + 33, 8).getBigUint64(0, true);
    } catch {
        return 0n;
    }
}

/* ------------------------------------------------------------------ */
/*  Server-backed market data (the fork's only book/price view)        */
/* ------------------------------------------------------------------ */

/** Last fill price from the server's /ticker (0 when no trades yet). */
export async function forkLastPrice(poolKey: string): Promise<number> {
    const res = await fetch("/api/deepbook/ticker");
    if (!res.ok) throw new Error(`ticker HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, { last_price?: number }>;
    return body[poolKey]?.last_price ?? 0;
}

export interface ForkServerOrder {
    order_id: string;
    balance_manager_id: string;
    type: "buy" | "sell";
    current_status: string;
    price: number;
    original_quantity: number;
    filled_quantity: number;
    remaining_quantity: number;
    placed_at: number;
    last_updated_at: number;
}

/** Open orders for a BM from the server's order_updates projection
 *  (`start_time=0` escapes the default 7-day lookback — fork clocks drift). */
export async function forkOpenOrders(
    poolKey: string,
    balanceManagerId: string,
): Promise<ForkServerOrder[]> {
    const res = await fetch(
        `/api/deepbook/orders/${poolKey}/${balanceManagerId}` +
            `?status=placed,partially_filled&start_time=0&limit=200`,
    );
    if (!res.ok) throw new Error(`orders HTTP ${res.status}`);
    return (await res.json()) as ForkServerOrder[];
}

/* ------------------------------------------------------------------ */
/*  Write-path helpers — no dry-run, no coin index, no unresolved      */
/*  object inputs                                                      */
/* ------------------------------------------------------------------ */

// The v2 SDK resolves `tx.object(id)` inputs THROUGH simulateTransaction at
// build time (observed live: SimulationError from resolveTransactionData),
// so on the fork every tx must be built from concrete refs: `objectRef` for
// owned objects, `sharedObjectRef` for shared ones (initial shared version
// via getObject's owner metadata), and `tx.object.clock()` — which the SDK
// inlines without resolution. This is the same discipline the sandbox's
// impersonation plugins follow (deep-funding.ts, trade-sim.ts).

/** SDK MAX_TIMESTAMP — "never expire" for limit orders. */
const MAX_TIMESTAMP = 1_844_674_407_370_955_161n;
const ORDER_TYPE_NO_RESTRICTION = 0;
const SELF_MATCHING_ALLOWED = 0;

/** A pool's identity as pinned in the fork manifest. */
export interface ForkPoolPin {
    objectId: string;
    initialSharedVersion: string | number;
    baseType: string;
    quoteType: string;
}

/** Concrete shared-object arg from live owner metadata (BMs are shared at a
 *  version the manifest can't pin — read it from the object). */
export async function sharedObjectArg(
    core: ForkCore,
    tx: Transaction,
    objectId: string,
    mutable: boolean,
) {
    const res = await core.getObject({ objectId, include: {} });
    const owner = (
        res.object as
            | { owner?: { Shared?: { initialSharedVersion?: string | number } } }
            | undefined
    )?.owner;
    const initial = owner?.Shared?.initialSharedVersion;
    if (initial === undefined) {
        throw new Error(`object ${objectId} is not shared (or owner metadata missing)`);
    }
    return tx.sharedObjectRef({
        objectId,
        initialSharedVersion: String(initial),
        mutable,
    });
}

/**
 * Give a tx explicit gas so building never dry-runs (no simulation on the
 * fork) and never consults the (dead) coin index: budget, price, and payment
 * from the sender's enumerable SUI coins. Multi-coin payments merge on
 * execution, so passing several consolidates faucet dust for free. The gas
 * coins must not also be tx inputs — fork deposits split SUI from tx.gas,
 * so that holds.
 *
 * The budget is capped to the payment total: a gas budget above what the
 * sender holds is rejected outright ("Balance of gas object N is lower than
 * the needed amount"), and the fork's SUI grants are faucet-sized — the
 * sandbox-api faucet hands out exactly 0.1 SUI, which equals the ceiling, so
 * an uncapped budget put every wallet below it after its FIRST tx and broke
 * every subsequent write (Create Balance Manager included).
 */
export async function setForkGas(core: ForkCore, tx: Transaction, sender: string): Promise<void> {
    const coins = (await listOwnedCoins(core, sender))
        .filter((c) => c.coinType.endsWith("::sui::SUI"))
        .sort((a, b) => (b.balance > a.balance ? 1 : -1))
        .slice(0, 16);
    if (coins.length === 0) {
        throw new Error(
            "No enumerable SUI coins to pay gas with — fund the wallet from the Faucet page first.",
        );
    }
    const available = coins.reduce((sum, c) => sum + c.balance, 0n);
    if (available < FORK_GAS_MIN_BUDGET) {
        throw new Error(
            `Not enough SUI for gas: wallet holds ${formatSui(available)} SUI, need at least ` +
                `${formatSui(FORK_GAS_MIN_BUDGET)} SUI. Top up from the Faucet page.`,
        );
    }
    tx.setGasBudget(available < FORK_GAS_BUDGET ? available : FORK_GAS_BUDGET);
    tx.setGasPrice(FORK_GAS_PRICE);
    tx.setGasPayment(coins.map(({ objectId, version, digest }) => ({ objectId, version, digest })));
}

/** MIST → a short human SUI string for error messages. */
const formatSui = (mist: bigint): string =>
    (Number(mist) / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * `balance_manager::deposit<T>` without the SDK's coinWithBalance intent
 * (its resolver needs the coin index). SUI splits from gas; other coins
 * merge the owner's enumerable coins and split the exact amount.
 */
export async function forkDeposit(
    core: ForkCore,
    tx: Transaction,
    args: {
        sender: string;
        deepbookPackageId: string;
        balanceManagerId: string;
        coinType: string;
        /** base units */
        amount: bigint;
    },
): Promise<void> {
    const { sender, deepbookPackageId, balanceManagerId, coinType, amount } = args;
    let depositCoin;
    if (coinType.endsWith("::sui::SUI")) {
        [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    } else {
        const wanted = normalizeStructTag(coinType);
        const coins = (await listOwnedCoins(core, sender)).filter(
            (c) => normalizeStructTag(c.coinType) === wanted,
        );
        const total = coins.reduce((sum, c) => sum + c.balance, 0n);
        if (total < amount) {
            throw new Error(
                `Wallet holds ${total} base units of ${coinType.split("::").pop()}, need ${amount}.`,
            );
        }
        const [primary, ...rest] = coins;
        const primaryArg = tx.objectRef(primary);
        if (rest.length > 0) {
            tx.mergeCoins(
                primaryArg,
                rest.map((c) => tx.objectRef(c)),
            );
        }
        [depositCoin] = tx.splitCoins(primaryArg, [tx.pure.u64(amount)]);
    }
    const bmArg = await sharedObjectArg(core, tx, balanceManagerId, true);
    tx.moveCall({
        target: `${deepbookPackageId}::balance_manager::deposit`,
        arguments: [bmArg, depositCoin],
        typeArguments: [coinType],
    });
}

/** `balance_manager::withdraw<T>` + transfer to the recipient. */
export async function forkWithdraw(
    core: ForkCore,
    tx: Transaction,
    args: {
        deepbookPackageId: string;
        balanceManagerId: string;
        coinType: string;
        /** base units */
        amount: bigint;
        recipient: string;
    },
): Promise<void> {
    const bmArg = await sharedObjectArg(core, tx, args.balanceManagerId, true);
    const coin = tx.moveCall({
        target: `${args.deepbookPackageId}::balance_manager::withdraw`,
        arguments: [bmArg, tx.pure.u64(args.amount)],
        typeArguments: [args.coinType],
    });
    tx.transferObjects([coin], args.recipient);
}

type OrderCommon = {
    deepbookPackageId: string;
    pool: ForkPoolPin;
    balanceManagerId: string;
};

/* ------------------------------------------------------------------ */
/*  Book pre-warm — the fork does not lazy-fetch children on execution  */
/* ------------------------------------------------------------------ */

/** BigVector<E>: UID(32) + depth u8 + length/max_slice_size/max_fan_out/
 *  root_id/last_id (5 × u64). */
const BIG_VECTOR_BYTES = 73;
/** BigVector's "no root" sentinel. */
const NO_SLICE = (1n << 64n) - 1n;
/** Bound the walk — a pathological book must not stall order placement. */
const MAX_SLICES_PER_LEVEL = 64;

const u64le = (b: Uint8Array, off: number): bigint =>
    new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, true);

/** Minimal ULEB128 decode (BCS vector lengths). */
function readUleb(b: Uint8Array, off: number): { value: number; size: number } {
    let value = 0;
    let shift = 0;
    let size = 0;
    for (;;) {
        const byte = b[off + size++] ?? 0;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value, size };
}

/** Read every slice of one BigVector so the fork holds it locally. */
async function prewarmBigVector(core: ForkCore, inner: Uint8Array, off: number): Promise<void> {
    const uid = `0x${bytesToHex(inner.slice(off, off + 32))}`;
    const depth = inner[off + 32] ?? 0;
    const length = u64le(inner, off + 33);
    const rootId = u64le(inner, off + 57);
    if (length === 0n || rootId === NO_SLICE) return;

    let level = [rootId];
    for (let d = 0; d <= depth && level.length > 0; d++) {
        const next: bigint[] = [];
        for (const sliceId of level.slice(0, MAX_SLICES_PER_LEVEL)) {
            const fieldId = deriveDynamicFieldID(
                uid,
                "u64",
                bcs.u64().serialize(sliceId).toBytes(),
            );
            const res = await core
                .getObject({ objectId: fieldId, include: { content: true } })
                .catch(() => null);
            const sc = res?.object?.content;
            // Reading is what materializes it; only interior nodes need parsing.
            if (!sc || d === depth) continue;
            // Field hdr(40) + Slice.prev(8) + Slice.next(8) + keys vector<u128>
            // + vals vector<u64> (child slice ids on an interior node).
            let so = 56;
            const keys = readUleb(sc, so);
            so += keys.size + keys.value * 16;
            const vals = readUleb(sc, so);
            so += vals.size;
            for (let i = 0; i < vals.value; i++) next.push(u64le(sc, so + i * 8));
        }
        level = next;
    }
}

/** Pools whose book has been materialized in this page's lifetime. */
const prewarmedPools = new Set<string>();

/**
 * Materialize a pool's order book on the fork before trading against it.
 *
 * The fork lazy-fetches objects on RPC reads but NOT on child reads during
 * execution, so the moment matching walks a BigVector leaf slice that has
 * never been read locally the whole tx aborts with `MoveAbort … abort code: 1
 * in 0x2::dynamic_field::borrow_child_object` (EFieldDoesNotExist) — which is
 * what every market order against mainnet-inherited liquidity used to hit.
 * A plain getObject on each slice is enough to pull it in. Memoized: the
 * fork keeps what it has fetched for the life of the chain.
 */
export async function prewarmPoolBook(core: ForkCore, poolId: string): Promise<void> {
    if (prewarmedPools.has(poolId)) return;
    prewarmedPools.add(poolId);
    try {
        const pool = await core.getObject({ objectId: poolId, include: { content: true } });
        const c = pool.object?.content;
        if (!c || c.length < 72) return;
        // Pool { id: UID(32), inner: Versioned { id: UID(32), version: u64 } }
        const innerFieldId = deriveDynamicFieldID(
            `0x${bytesToHex(c.slice(32, 64))}`,
            "u64",
            bcs.u64().serialize(u64le(c, 64)).toBytes(),
        );
        const inner = await core.getObject({
            objectId: innerFieldId,
            include: { content: true },
        });
        const ic = inner.object?.content;
        if (!ic) return;
        // Field hdr(40) + allowed_versions vector<u64> + pool_id(32)
        // + book{ tick_size, lot_size, min_size (3 × u64), bids, asks }
        let off = 40;
        const allowed = readUleb(ic, off);
        off += allowed.size + allowed.value * 8 + 32 + 24;
        await prewarmBigVector(core, ic, off); // bids
        await prewarmBigVector(core, ic, off + BIG_VECTOR_BYTES); // asks
    } catch {
        // Best effort: a miss just leaves the old abort in place, and the
        // layout could shift under a package upgrade.
        prewarmedPools.delete(poolId);
    }
}

/** Shared prologue for the order calls: concrete pool + BM args and an
 *  owner trade proof. Pre-warms the book first — every one of these calls
 *  walks it during execution. */
async function orderPrologue(core: ForkCore, tx: Transaction, args: OrderCommon) {
    await prewarmPoolBook(core, args.pool.objectId);
    const poolArg = tx.sharedObjectRef({
        objectId: args.pool.objectId,
        initialSharedVersion: String(args.pool.initialSharedVersion),
        mutable: true,
    });
    const bmArg = await sharedObjectArg(core, tx, args.balanceManagerId, true);
    const proof = tx.moveCall({
        target: `${args.deepbookPackageId}::balance_manager::generate_proof_as_owner`,
        arguments: [bmArg],
    });
    return { poolArg, bmArg, proof, types: [args.pool.baseType, args.pool.quoteType] };
}

export async function forkPlaceLimitOrder(
    core: ForkCore,
    tx: Transaction,
    args: OrderCommon & {
        clientOrderId: string;
        /** raw DeepBook price (FLOAT_SCALAR-scaled, tick-aligned by the UI). */
        priceRaw: bigint;
        /** base units */
        quantityRaw: bigint;
        isBid: boolean;
    },
): Promise<void> {
    const { poolArg, bmArg, proof, types } = await orderPrologue(core, tx, args);
    tx.moveCall({
        target: `${args.deepbookPackageId}::pool::place_limit_order`,
        arguments: [
            poolArg,
            bmArg,
            proof,
            tx.pure.u64(BigInt(args.clientOrderId)),
            tx.pure.u8(ORDER_TYPE_NO_RESTRICTION),
            tx.pure.u8(SELF_MATCHING_ALLOWED),
            tx.pure.u64(args.priceRaw),
            tx.pure.u64(args.quantityRaw),
            tx.pure.bool(args.isBid),
            tx.pure.bool(false), // pay fees in input token (DEEP_SUI is whitelisted: zero)
            tx.pure.u64(MAX_TIMESTAMP),
            tx.object.clock(),
        ],
        typeArguments: types,
    });
    settleInto(tx, args, poolArg, bmArg, proof, types);
}

/**
 * Reclaim amounts parked on the pool account.
 *
 * `place_order_int` already settles the CURRENT order's fills into the
 * BalanceManager (pool.move — `vault.settle_balance_manager` right after
 * `state.process_create`), so this is not needed for the order being placed.
 * What it does collect is the proceeds of YOUR resting maker orders that
 * someone else filled later: those sit as settled amounts until your next
 * interaction with the pool. Cheap, and a no-op when nothing is parked.
 *
 * If a bought coin still reads as 0 afterwards AND selling it aborts with
 * `abort code: 3` in `withdraw_with_proof`, that BalanceManager's Bag entry
 * for the coin has gone unreadable to the VM itself — SUI-FORK-ISSUES #10.
 * Deposits into it are lost; the only escape is a different BalanceManager.
 */
function settleInto(
    tx: Transaction,
    args: OrderCommon,
    poolArg: ReturnType<Transaction["sharedObjectRef"]>,
    bmArg: ReturnType<Transaction["sharedObjectRef"]>,
    proof: ReturnType<Transaction["moveCall"]>,
    types: string[],
): void {
    tx.moveCall({
        target: `${args.deepbookPackageId}::pool::withdraw_settled_amounts`,
        arguments: [poolArg, bmArg, proof],
        typeArguments: types,
    });
}

export async function forkPlaceMarketOrder(
    core: ForkCore,
    tx: Transaction,
    args: OrderCommon & {
        clientOrderId: string;
        /** base units */
        quantityRaw: bigint;
        isBid: boolean;
    },
): Promise<void> {
    const { poolArg, bmArg, proof, types } = await orderPrologue(core, tx, args);
    tx.moveCall({
        target: `${args.deepbookPackageId}::pool::place_market_order`,
        arguments: [
            poolArg,
            bmArg,
            proof,
            tx.pure.u64(BigInt(args.clientOrderId)),
            tx.pure.u8(SELF_MATCHING_ALLOWED),
            tx.pure.u64(args.quantityRaw),
            tx.pure.bool(args.isBid),
            tx.pure.bool(false),
            tx.object.clock(),
        ],
        typeArguments: types,
    });
    settleInto(tx, args, poolArg, bmArg, proof, types);
}

export async function forkCancelOrder(
    core: ForkCore,
    tx: Transaction,
    args: OrderCommon & { orderId: string },
): Promise<void> {
    const { poolArg, bmArg, proof, types } = await orderPrologue(core, tx, args);
    tx.moveCall({
        target: `${args.deepbookPackageId}::pool::cancel_order`,
        arguments: [poolArg, bmArg, proof, tx.pure.u128(BigInt(args.orderId)), tx.object.clock()],
        typeArguments: types,
    });
}

export async function forkCancelAllOrders(
    core: ForkCore,
    tx: Transaction,
    args: OrderCommon,
): Promise<void> {
    const { poolArg, bmArg, proof, types } = await orderPrologue(core, tx, args);
    tx.moveCall({
        target: `${args.deepbookPackageId}::pool::cancel_all_orders`,
        arguments: [poolArg, bmArg, proof, tx.object.clock()],
        typeArguments: types,
    });
}

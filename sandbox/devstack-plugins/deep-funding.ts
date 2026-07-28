// DEEP funding-strategy plugin for the DeepBook sandbox's devstack fork.
//
// Contributes a `coinType:<DEEP>` funding strategy so that
// `account('alice', { funding: [{ coin: deep, amount }] })` is funded by
// transferring DEEP from an impersonated mainnet whale (DEEP is fixed-supply —
// its TreasuryCap is locked in a ProtectedTreasury, so the sandbox can't mint;
// it sources DEEP from a large holder). The donor address + rationale + caps
// live in `sandbox/deployments/fork-impersonation.md`.
//
// Mechanism (validated by the spike in scripts/spikes/devstack-funding/):
//   - `defineFaucetStrategy` is SUI-only, so a non-SUI coin is contributed
//     imperatively via `ctx.provides({ kind: 'strategy-contributor', ... })`
//     (PluginContext, inside `start`) under a `coinType:<fullType>` key,
//     wrapping an `AccountFundingStrategy` at priority 1 (the built-in
//     coin.known mint strategy sits at priority 0 — wrong for DEEP — and ours
//     wins).
//   - The body impersonates the whale: it CANNOT sign (no key) and CANNOT let
//     the SDK auto-select gas. A mainnet fork lazily materializes objects on
//     direct access by id (`getObject`) but does NOT build an owner->coins index,
//     so `listCoins`/`getOwnedObjects` return EMPTY on the fork — the donor's
//     coins can only be resolved by KNOWN object id. It therefore `getObject`s
//     the donor's DEEP source coin + a SUI gas coin (ids default to the known
//     whale coins; override via DEEP_DONOR_COIN_ID / SUI_GAS_COIN_ID, and refresh
//     stale ids with `node scripts/refresh-donor-coins.mjs`), builds the PTB
//     OFFLINE with those concrete refs, and executes empty-sig via
//     `sdk.core.executeTransaction({ signatures: [] })`.
//
// KNOWN BLOCKER (sui-fork): on a STOCK fork, both the DEEP transfer AND any
// `getObject` of a coin abort the fork process — the SDK enriches via
// `GetCoinInfo(DEEP)`, which misses the (un-materialized) shared CoinRegistry
// `Currency` object and hits an unimplemented index `todo!()`. The patched fork
// (`get_coin_info -> Ok(None)`) removes the abort, so both `getObject` and the
// transfer work. Until sui-fork fixes this upstream (lazy-fetch the shared
// Currency / stop panicking), the live path requires the patched fork image; see
// scripts/spikes/devstack-funding/SUI-FORK-NOTES.md.

import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { Effect } from "effect";
import {
    account,
    definePlugin,
    PluginContext,
    sui,
    type AccountFundingStrategy,
    type FaucetBodyError,
    type FaucetUnreachable,
} from "@mysten-incubation/devstack";

/** Mainnet DEEP coin type — the fork inherits mainnet state, so this is the real
 *  mainnet package, not the localnet-deployed DEEP. */
export const DEEP_COIN_TYPE =
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
const SUI_COIN_TYPE = "0x2::sui::SUI";
const DEEP_DECIMALS = 6n;

// Default donor coin object ids (the mainnet whale's single ~4.5B DEEP coin and a
// SUI coin for gas). The fork can't enumerate coins, so these are resolved by id
// via getObject. They can move if the donor spends them — override via
// DEEP_DONOR_COIN_ID / SUI_GAS_COIN_ID, or refresh with
// `node scripts/refresh-donor-coins.mjs`.
const DEFAULT_DEEP_DONOR_COIN_ID =
    "0x3b5cbb0b1bd8afd4dbbf5919e29e83a86ee99a2509c798950d07b4da3be2ded4";
const DEFAULT_SUI_GAS_COIN_ID =
    "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714";

/** Default funding caps (whole DEEP). Overridable per-instance (opts) or via env
 *  (MAX_DEEP_PER_REQUEST / MAX_DEEP_PER_SESSION, also whole DEEP). */
const DEFAULT_PER_REQUEST_DEEP = 100_000; // 100k DEEP
const DEFAULT_PER_SESSION_DEEP = 10_000_000; // 10M DEEP

// Must match devstack's internal fork-impersonation constants so the empty-sig
// tx validates against the fork.
const FORK_GAS_BUDGET = 100_000_000n;
const FORK_GAS_PRICE = 1_000n;

// --- Subsets of devstack's public `sui` plugin value that we consume ---

type CoinRef = { objectId: string; version: string; digest: string };
/** The fork gRPC client surface we use.
 *  - `getObject` resolves a coin by KNOWN id (the fork materializes objects on
 *    direct-by-id access but does NOT build an owner->coins index, so
 *    listCoins/getOwnedObjects return empty on the fork). With
 *    `include: { json: true }` the response carries the parsed Move value —
 *    that's how `remainingDeep` reads the donor coin's balance without
 *    `getBalance`, which needs the owner->coins index the fork doesn't have.
 *  - `executeTransaction` with empty signatures is the impersonation path. */
export type ForkCore = {
    getObject: (args: {
        objectId: string;
        include?: { content?: boolean; json?: boolean };
    }) => Promise<{
        object?: {
            objectId: string;
            version: string;
            digest: string;
            type?: string;
            json?: unknown;
        };
    }>;
    executeTransaction: (args: {
        transaction: Uint8Array;
        signatures: readonly string[];
        include?: { effects?: boolean; objectTypes?: boolean };
    }) => Promise<unknown>;
};

// --- Tagged errors devstack's funding/faucet model expects. The factory
// functions are internal to devstack, so we construct the (public) tagged
// shapes directly. Transport/connection failure -> FaucetUnreachable; cap hit /
// drained / build / on-chain revert -> FaucetBodyError. ---

const sentinelUrl = (donor: string) => `fork-impersonation://${donor}`;

function bodyError(
    donor: string,
    address: string,
    amount: bigint,
    message: string,
): FaucetBodyError {
    return {
        _tag: "FaucetBodyError",
        url: sentinelUrl(donor),
        address,
        amount,
        status: 0,
        reason: "failure-status",
        message,
    };
}

function unreachable(
    donor: string,
    address: string,
    amount: bigint,
    message: string,
    cause: unknown,
): FaucetUnreachable {
    return {
        _tag: "FaucetUnreachable",
        url: sentinelUrl(donor),
        address,
        amount,
        message,
        cause,
    };
}

// --- Coin resolution (by KNOWN object id via getObject — the fork can't
// enumerate coins; see the header) ---

/** Resolve a known coin object's current ref via `getObject` (works on the
 *  patched fork). Verifies it still exists and is a Coin of the expected type —
 *  a clear error beats a cryptic execution revert if the donor spent the coin.
 *  The expected `module::Name` suffix avoids address-padding mismatches between
 *  the on-chain type string and the coin-type literal. */
async function coinRefById(
    core: ForkCore,
    objectId: string,
    expectCoinType: string,
): Promise<CoinRef> {
    const res = await core.getObject({ objectId });
    const o = res.object;
    if (o === undefined) {
        throw new Error(
            `coin ${objectId} not found on the fork (donor spent it? refresh via 'node scripts/refresh-donor-coins.mjs')`,
        );
    }
    const suffix = expectCoinType.split("::").slice(1).join("::"); // e.g. "deep::DEEP"
    if (o.type !== undefined && !o.type.includes(suffix)) {
        throw new Error(`object ${objectId} is not a Coin<${expectCoinType}> (got ${o.type})`);
    }
    return { objectId: o.objectId, version: o.version, digest: o.digest };
}

/** Pull the `balance` out of a Coin object's parsed-JSON Move value
 *  (`getObject` with `include: { json: true }`). The Move `Coin` struct is
 *  `{ id: UID, balance: Balance<T> }`; the JSON rendering carries `balance` as a
 *  string/number, or as `{ value }` depending on SDK version — accept both.
 *  Returns 0n on any shape mismatch (display-only, best-effort). */
export function coinBalanceFromJson(json: unknown): bigint {
    const balance = (json as { balance?: unknown } | undefined)?.balance;
    const raw =
        typeof balance === "object" && balance !== null
            ? (balance as { value?: unknown }).value
            : balance;
    if (typeof raw === "string" || typeof raw === "number") {
        try {
            return BigInt(raw);
        } catch {
            return 0n;
        }
    }
    return 0n;
}

// --- Empty-sig "impersonation" tx builder (offline; concrete refs only) ---

// Detect a revert in the real @mysten/sui v2 `TransactionResult` envelope:
//   { $kind: 'Transaction' | 'FailedTransaction',
//     Transaction|FailedTransaction: { status: { success, error }, effects?: { status } } }
// devstack's own check is `raw.$kind === 'FailedTransaction'` (sui/mode/fork.mjs).
function executionFailureReason(raw: unknown): string | null {
    type Status = { success?: boolean; error?: unknown };
    type Tx = { status?: Status; effects?: { status?: Status } };
    const r = raw as { $kind?: string; Transaction?: Tx; FailedTransaction?: Tx };
    if (r?.$kind === "FailedTransaction") {
        const f = r.FailedTransaction;
        const status = f?.status ?? f?.effects?.status;
        return JSON.stringify(status?.error ?? status ?? "FailedTransaction");
    }
    const status = r?.Transaction?.status ?? r?.Transaction?.effects?.status;
    if (status?.success === false) return JSON.stringify(status.error ?? status);
    return null;
}

async function buildImpersonationBytes(
    tx: Transaction,
    sender: string,
    gas: CoinRef,
): Promise<Uint8Array> {
    tx.setSender(sender);
    tx.setGasBudget(FORK_GAS_BUDGET);
    tx.setGasPrice(FORK_GAS_PRICE);
    tx.setGasOwner(sender);
    tx.setGasPayment([gas]);
    if (tx.getData().expiration == null) tx.setExpiration({ None: true });
    await tx.prepareForSerialization({});
    const data = tx.getData();
    // All inputs are concrete refs (resolved up-front via coinRefById/getObject),
    // so serialization must not need an implicit getObject. Fail loudly if a future
    // change leaves an input unresolved (an extra fork round-trip + abort surface).
    for (const input of data.inputs) {
        if ((input as { UnresolvedObject?: unknown }).UnresolvedObject !== undefined) {
            throw new Error(
                "deep-funding: an object input is unresolved; build the PTB with concrete object refs (resolve ids via getObject first).",
            );
        }
    }
    return TransactionDataBuilder.restore(data).build();
}

// --- The funding strategy (exported so it can be unit-tested against a stub) ---

export type DeepFundingStrategyArgs = {
    core: ForkCore;
    /** non-null ⇒ fork mode (the only mode impersonation works in). */
    fork: object | null;
    donor: string;
    coinType: string;
    /** the donor's DEEP source coin object id (resolved by id — the fork can't
     *  enumerate coins). */
    deepCoinId: string;
    /** the donor's SUI gas coin object id. */
    gasCoinId: string;
    /** caps in BASE units (DEEP, 6 dp). */
    perRequestCap: bigint;
    sessionCap: bigint;
    /** shared mutable session counter (cumulative drawn this stack lifetime). */
    session: { drawn: bigint };
};

export function deepFundingStrategy(args: DeepFundingStrategyArgs): AccountFundingStrategy {
    const {
        core,
        fork,
        donor,
        coinType,
        deepCoinId,
        gasCoinId,
        perRequestCap,
        sessionCap,
        session,
    } = args;
    return {
        // We neither sign as the recipient nor spend the recipient's funds: the
        // whale is impersonated via empty-sig execute, so the dispatcher serializes
        // requests for us (usesAccountSigner: false).
        usesAccountSigner: false,
        requiresRecipientAccount: false,
        request: ({ address, amount }) =>
            Effect.gen(function* () {
                if (amount <= 0n) return;

                if (fork === null) {
                    return yield* Effect.fail(
                        bodyError(
                            donor,
                            address,
                            amount,
                            "sui plugin is not in fork mode; impersonation funding requires mode:'fork'.",
                        ),
                    );
                }
                if (amount > perRequestCap) {
                    return yield* Effect.fail(
                        bodyError(
                            donor,
                            address,
                            amount,
                            `requested ${amount} exceeds per-request cap ${perRequestCap} (base units).`,
                        ),
                    );
                }
                // Reserve against the session ceiling SYNCHRONOUSLY (no await between the
                // check and the reservation). The dispatcher serializes per-recipient
                // (usesAccountSigner:false) but NOT across recipients, so two concurrent
                // requests could otherwise both pass the check and overshoot. The
                // reservation is rolled back below on any failure/interrupt.
                if (session.drawn + amount > sessionCap) {
                    return yield* Effect.fail(
                        bodyError(
                            donor,
                            address,
                            amount,
                            `session draw ceiling ${sessionCap} reached (drawn ${session.drawn}, requested ${amount}).`,
                        ),
                    );
                }
                session.drawn += amount;

                return yield* Effect.gen(function* () {
                    // Resolve the donor's DEEP source coin + a SUI gas coin by KNOWN id
                    // (the fork can't enumerate coins). getObject works on the patched
                    // fork; coinRefById throws a clear error if an id went stale.
                    const deepCoin = yield* Effect.tryPromise({
                        try: () => coinRefById(core, deepCoinId, coinType),
                        catch: (c) =>
                            bodyError(
                                donor,
                                address,
                                amount,
                                `resolve DEEP source coin: ${String(c)}`,
                            ),
                    });
                    const gas = yield* Effect.tryPromise({
                        try: () => coinRefById(core, gasCoinId, SUI_COIN_TYPE),
                        catch: (c) =>
                            bodyError(donor, address, amount, `resolve SUI gas coin: ${String(c)}`),
                    });

                    // splitCoins(donor's DEEP, [amount]) -> transferObjects([chunk], recipient).
                    const tx = new Transaction();
                    const [chunk] = tx.splitCoins(tx.objectRef(deepCoin), [tx.pure.u64(amount)]);
                    tx.transferObjects([chunk], address);

                    const bytes = yield* Effect.tryPromise({
                        try: () => buildImpersonationBytes(tx, donor, gas),
                        catch: (c) =>
                            bodyError(
                                donor,
                                address,
                                amount,
                                `failed to build impersonation tx: ${String(c)}`,
                            ),
                    });

                    // Empty signatures ⇒ the fork executes as the declared sender. A thrown
                    // error here is a transport/connection failure (fork unreachable);
                    // a returned-but-FailedTransaction result is an on-chain revert.
                    const raw = yield* Effect.tryPromise({
                        try: () =>
                            core.executeTransaction({
                                transaction: bytes,
                                signatures: [],
                                include: { effects: true },
                            }),
                        catch: (c) =>
                            unreachable(
                                donor,
                                address,
                                amount,
                                "fork executeTransaction failed (transport).",
                                c,
                            ),
                    });
                    const failure = executionFailureReason(raw);
                    if (failure !== null) {
                        return yield* Effect.fail(
                            bodyError(
                                donor,
                                address,
                                amount,
                                `impersonation tx reverted on the fork: ${failure}`,
                            ),
                        );
                    }
                }).pipe(
                    // Release the reservation on any failure/interrupt; on success it stands.
                    Effect.onError(() =>
                        Effect.sync(() => {
                            session.drawn -= amount;
                        }),
                    ),
                );
            }),
    };
}

// --- The plugin factory ---

function resolveCap(envName: string, optWhole: number | undefined, defaultWhole: number): bigint {
    const fromEnv = process.env[envName]?.trim();
    const whole = optWhole ?? (fromEnv ? Number(fromEnv) : defaultWhole);
    if (!Number.isFinite(whole) || whole < 0) {
        throw new Error(`deep-funding: invalid cap for ${envName}: ${whole}`);
    }
    return BigInt(Math.floor(whole)) * 10n ** DEEP_DECIMALS;
}

export type DeepFundingOptions = {
    /** the fork sui network member. */
    sui: ReturnType<typeof sui>;
    /** the impersonated DEEP whale: account(name, { kind: 'impersonate', address: donor }). */
    whale: ReturnType<typeof account>;
    /** per-request cap in whole DEEP (default 100k; env MAX_DEEP_PER_REQUEST). */
    perRequestDeep?: number;
    /** total session draw ceiling in whole DEEP (default 10M; env MAX_DEEP_PER_SESSION). */
    sessionDeep?: number;
    /** override the funded coin type (default mainnet DEEP). */
    coinType?: string;
    /** donor's DEEP source coin object id (default the known whale coin; env
     *  DEEP_DONOR_COIN_ID). The fork resolves it by id — refresh stale ids with
     *  `node scripts/refresh-donor-coins.mjs`. */
    deepCoinId?: string;
    /** donor's SUI gas coin object id (default known; env SUI_GAS_COIN_ID). */
    gasCoinId?: string;
};

/**
 * Build the DEEP funding-strategy plugin. Composed into `devstack.config.ts`:
 *
 *   const suiRef = sui({ mode: 'fork', upstream: 'mainnet' });
 *   const whale  = account('deepWhale', { kind: 'impersonate', address: DEEP_DONOR_ADDRESS });
 *   const deep   = coin.known(DEEP_COIN_TYPE);
 *   defineDevstack({ members: [suiRef, whale, deepFundingFromWhale({ sui: suiRef, whale }), deep,
 *     account('alice', { funding: [{ coin: deep, amount }] }) ] });
 *
 * Its resolved value publishes { donor, coinType, perRequestCap, sessionCap,
 * sessionDrawn(), remainingDeep } for the dashboard.
 */
export function deepFundingFromWhale(opts: DeepFundingOptions) {
    const coinType = opts.coinType ?? DEEP_COIN_TYPE;
    const deepCoinId =
        opts.deepCoinId ?? (process.env.DEEP_DONOR_COIN_ID?.trim() || DEFAULT_DEEP_DONOR_COIN_ID);
    const gasCoinId =
        opts.gasCoinId ?? (process.env.SUI_GAS_COIN_ID?.trim() || DEFAULT_SUI_GAS_COIN_ID);
    const perRequestCap = resolveCap(
        "MAX_DEEP_PER_REQUEST",
        opts.perRequestDeep,
        DEFAULT_PER_REQUEST_DEEP,
    );
    const sessionCap = resolveCap(
        "MAX_DEEP_PER_SESSION",
        opts.sessionDeep,
        DEFAULT_PER_SESSION_DEEP,
    );
    // Per-stack cumulative draw, shared by the strategy (writes) and the resolved
    // value's sessionDrawn() (reads).
    const session = { drawn: 0n };

    return definePlugin({
        id: "deep-funding",
        role: "service",
        section: "service",
        dependsOn: { sui: opts.sui, whale: opts.whale },
        start: (deps) =>
            Effect.gen(function* () {
                const ctx = yield* PluginContext;
                const donor = deps.whale.address;
                const core = deps.sui.sdk.core as ForkCore;
                const fork = deps.sui.fork;
                const strategy = deepFundingStrategy({
                    core,
                    fork,
                    donor,
                    coinType,
                    deepCoinId,
                    gasCoinId,
                    perRequestCap,
                    sessionCap,
                    session,
                });

                // Contribute the coinType funding strategy. devstack 0.3.0 replaced the
                // static `capabilities` array + the `strategyContributor()` helper with
                // the imperative `ctx.provides(...)` (PluginContext) inside `start`. The
                // key the account-funding pass dispatches a `{ coin: DEEP, amount }`
                // entry to; coin.known contributes the same key at priority 0 (mint —
                // wrong for fixed-supply DEEP), so ours wins at 1.
                ctx.provides({
                    kind: "strategy-contributor",
                    capabilityKey: `coinType:${coinType}`,
                    strategy,
                    autoMounted: false,
                    priority: 1,
                });

                return {
                    donor,
                    coinType,
                    perRequestCap,
                    sessionCap,
                    sessionDrawn: () => session.drawn,
                    // Live, best-effort display of the DEEP left in the donor's funding
                    // source coin (dashboard only; not on the boot/funding path). Reads
                    // the known coin object by id with `include: { json: true }` — the
                    // only balance read that works on a fork, which has no owner->coins
                    // index for `getBalance` (docs: "use ChainProbe for balance reads";
                    // same by-id principle). 0n on any miss rather than an error.
                    // Re-reads on each evaluation, so it decrements as sessions draw.
                    remainingDeep: Effect.promise(async () => {
                        try {
                            const r = await core.getObject({
                                objectId: deepCoinId,
                                include: { json: true },
                            });
                            return coinBalanceFromJson(r.object?.json);
                        } catch {
                            return 0n;
                        }
                    }),
                    strategy,
                };
            }),
    });
}

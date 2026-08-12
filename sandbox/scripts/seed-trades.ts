// Seed demo trades on the fork's DEEP_SUI pool so the dashboard's DeepBook
// page has real candles/ticker data to show.
//
// Mechanics (all empirically debugged against the fork — see SUI-FORK-NOTES):
//   - Impersonates the DEEP whale via empty-signature `executeTransaction`
//     (the deep-funding.ts path): PTBs are built OFFLINE with concrete object
//     refs — no simulation, which the fork doesn't serve (SEDEFI-358).
//   - Pre-warms the pool's Versioned inner by id first: execution-path child
//     reads do NOT lazy-fetch on the fork, so the first order would abort in
//     dynamic_field::borrow_child_object without it.
//   - One-time setup: create+share a BalanceManager (persisted in
//     .seed-trades-state.json and reused — the whale's known SUI coin is
//     nearly empty, so parked BM funds must not leak), deposit DEEP + SUI.
//   - Each batch: one PTB placing a bid INSIDE the mainnet spread and an IOC
//     ask at the same price — a pure self-fill (SELF_MATCHING_ALLOWED) that
//     recycles the scarce SUI in-tx and avoids a pin-era maker whose account
//     state cannot be materialized (sells crossing it abort in
//     vec_set::remove).
//   - Between batches `docker exec <fork> sui-fork advance-clock` moves the
//     fork clock one candle bucket, capped at wall time (future-stamped
//     fills are invisible to the server's windowed queries). The dashboard's
//     advanceClock GraphQL mutation is NOT used — it silently no-ops on fork
//     mode (devstack 0.7.0).
//   - Ends with `CALL update_all_ohclv(...)` in Postgres (production runs it
//     on a scheduler this stack doesn't have) and polls /ohclv.
//
// DEEP_SUI is whitelisted (zero fees, `pay_with_deep: false`), so no DEEP fee
// staking is needed. Trades are demo data — this script is manual, not part
// of `deploy-all`.
//
// Run (stack must be up): pnpm exec tsx scripts/seed-trades.ts
// Knobs: TRADE_BATCHES (default 8 — note a rerun soon after a successful one
//        finds the fork clock already at wall time, so its fills cluster into
//        one candle bucket instead of one per batch; spread returns once wall
//        time moves on), TRADE_QTY_DEEP (default 40), FORK_RPC_URL (overrides
//        the RPC url only — clock control still targets the first `sui-fork`
//        container Docker lists), DASHBOARD_URL, DASHBOARD_HOST.

import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { deriveDynamicFieldID } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "..", "deployments", "mainnet-fork.json");
const STATE_PATH = resolve(HERE, "..", ".seed-trades-state.json");

// Donor state (same pins as devstack-plugins/deep-funding.ts).
const WHALE =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const WHALE_DEEP_COIN =
    process.env.DEEP_DONOR_COIN ??
    "0x5f6e1d15c2b42ddbe4a827d509857184ea52c425fbe02ba91cae0cb71e40888e";
const WHALE_GAS_COIN =
    process.env.DEEP_DONOR_GAS_COIN ??
    "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714";

const GAS_BUDGET = 100_000_000n;
const GAS_PRICE = 1_000n;

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://127.0.0.1:9810";
const DASHBOARD_HOST =
    process.env.DASHBOARD_HOST ?? "api.deepbook-sandbox.devstack-plugins.localhost";
const SERVER_URL = process.env.DEEPBOOK_SERVER_URL ?? "http://127.0.0.1:9008";

const BATCHES = Number(process.env.TRADE_BATCHES ?? 8);
const QTY_DEEP = Number(process.env.TRADE_QTY_DEEP ?? 40);
const CANDLE_STEP_MS = 6 * 60 * 1000; // > one 5m bucket per batch

// DeepBook scalars for DEEP(6)/SUI(9); price u64 = float × 1e9 × qScalar/bScalar.
const DEEP_SCALAR = 1_000_000n;
const PRICE_MULT = 1_000_000_000_000n; // 1e9 × 1e9 / 1e6
const TICK_SIZE = 10_000_000n; // DEEP_SUI tick from the manifest
const MAX_TIMESTAMP = 1_844_674_407_370_955_161n; // SDK MAX_TIMESTAMP
const CLOCK_ID = "0x0000000000000000000000000000000000000000000000000000000000000006";

const log = (msg: string) => console.error(`[seed-trades] ${msg}`);
const fail = (msg: string): never => {
    console.error(`[seed-trades] ERROR: ${msg}`);
    process.exit(1);
};

// ---------------------------------------------------------------------------
// Fork RPC discovery: the sui-fork container publishes its gRPC port on a
// random host port; resolve it via docker (FORK_RPC_URL overrides).
let forkContainer: string | null = null;

const forkRpcUrl = (): string => {
    const name = execFileSync(
        "docker",
        ["ps", "--filter", "name=sui-fork", "--format", "{{.Names}}"],
        {
            encoding: "utf8",
        },
    )
        .split("\n")
        .filter(Boolean)[0];
    forkContainer = name ?? null;
    if (process.env.FORK_RPC_URL) return process.env.FORK_RPC_URL;
    if (!name)
        return fail("no running sui-fork container found — is the stack up (pnpm deploy-all)?");
    const port = execFileSync("docker", ["port", name, "9000/tcp"], { encoding: "utf8" })
        .split("\n")[0]
        ?.match(/:(\d+)$/)?.[1];
    if (!port) return fail(`could not resolve the published gRPC port of ${name}`);
    return `http://127.0.0.1:${port}`;
};

// ---------------------------------------------------------------------------
// Impersonated execution (mirrors deep-funding.ts).
type Core = SuiGrpcClient["core"];
type ObjectRef = { objectId: string; version: string; digest: string };

const objectRef = async (core: Core, objectId: string): Promise<ObjectRef> => {
    const res = await core.getObject({ objectId });
    const o = res.object;
    if (!o) return fail(`object ${objectId} not found on the fork`);
    return { objectId: o.objectId, version: String(o.version), digest: o.digest };
};

const buildImpersonationBytes = async (tx: Transaction, gas: ObjectRef): Promise<Uint8Array> => {
    tx.setSender(WHALE);
    tx.setGasBudget(GAS_BUDGET);
    tx.setGasPrice(GAS_PRICE);
    tx.setGasOwner(WHALE);
    tx.setGasPayment([gas]);
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

// Same failure shape deep-funding.ts documents for the fork's gRPC surface.
const executionFailure = (raw: unknown): string | null => {
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
};

const execute = async (
    core: Core,
    tx: Transaction,
    gas: ObjectRef,
    label: string,
): Promise<unknown> => {
    const bytes = await buildImpersonationBytes(tx, gas);
    const raw = await core
        .executeTransaction({
            transaction: bytes,
            signatures: [],
            include: { effects: true, objectTypes: true },
        })
        .catch((cause: unknown) => {
            throw new Error(
                `${label}: fork executeTransaction failed (transport): ${String(cause)}`,
            );
        });
    const failure = executionFailure(raw);
    if (failure !== null) throw new Error(`${label}: reverted on the fork: ${failure}`);
    return raw;
};

/** Find the created BalanceManager (id + version = initial shared version) in
 *  the execution response, defensively across the proto-ish shape. */
const findCreatedBalanceManager = (raw: unknown): { objectId: string; version: string } => {
    const tx = (raw as { Transaction?: unknown }).Transaction as
        | { effects?: { changedObjects?: unknown[] }; objectTypes?: Record<string, string> }
        | undefined;
    const changed = tx?.effects?.changedObjects ?? [];
    const types = tx?.objectTypes ?? {};
    for (const entry of changed) {
        const c = entry as {
            objectId?: string;
            idOperation?: string;
            outputVersion?: string | number;
        };
        if (!c.objectId) continue;
        const created = String(c.idOperation ?? "").toUpperCase() === "CREATED";
        const isBm = String(types[c.objectId] ?? "").includes("::balance_manager::BalanceManager");
        if (created && isBm)
            return { objectId: c.objectId, version: String(c.outputVersion ?? "") };
    }
    console.error(JSON.stringify(raw, null, 2).slice(0, 4000));
    return fail(
        "could not locate the created BalanceManager in the execution response (dumped above)",
    );
};

// ---------------------------------------------------------------------------
// Dashboard GraphQL (clock control + Pyth-implied mid).
// node:http rather than fetch: the router routes by Host header, and fetch
// (undici) silently drops a caller-set `host` — http.request allows it.
const graphql = (query: string): Promise<Record<string, unknown>> =>
    new Promise((resolvePromise, reject) => {
        const url = new URL(`${DASHBOARD_URL}/graphql`);
        const req = request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: "POST",
                headers: { "content-type": "application/json", host: DASHBOARD_HOST },
            },
            (res) => {
                let body = "";
                res.on("data", (chunk: unknown) => {
                    body += String(chunk);
                });
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(body) as {
                            data?: Record<string, unknown>;
                            errors?: unknown;
                        };
                        if ((res.statusCode ?? 500) >= 300 || parsed.errors) {
                            reject(
                                new Error(
                                    `dashboard GraphQL failed: ${JSON.stringify(parsed.errors ?? res.statusCode)}`,
                                ),
                            );
                        } else {
                            resolvePromise(parsed.data ?? {});
                        }
                    } catch {
                        reject(
                            new Error(
                                `dashboard GraphQL non-JSON response (${res.statusCode}): ${body.slice(0, 120)}`,
                            ),
                        );
                    }
                });
            },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ query }));
    });

const clockNowMs = async (core: Core): Promise<bigint> => {
    const res = await core.getObject({ objectId: CLOCK_ID, include: { content: true } });
    const content = res.object?.content;
    if (!content || content.length < 40) return fail("could not read the on-chain Clock object");
    // Clock BCS: UID (32 bytes) + timestamp_ms (u64 LE).
    return new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true);
};

// The devstack dashboard's advanceClock mutation returns ok but silently
// no-ops against fork mode (devstack 0.7.0), so drive the fork's own CLI in
// the container instead — it atomically bumps Clock AND seals a checkpoint
// with the matching timestamp (see scripts/spikes/pyth/).
const advanceClockBy = (byMs: bigint): void => {
    if (!forkContainer) return fail("fork container name unknown — forkRpcUrl() not called?");
    execFileSync(
        "docker",
        ["exec", forkContainer, "sui-fork", "advance-clock", "--duration-ms", byMs.toString()],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
};

const pythImpliedMid = async (): Promise<number> => {
    try {
        const data = await graphql(`
            {
                deepbookInfo {
                    pythFeeds {
                        symbol
                        price
                        expo
                    }
                }
            }
        `);
        const feeds = (
            data.deepbookInfo as { pythFeeds: { symbol: string; price: string; expo: number }[] }[]
        )[0]?.pythFeeds;
        const usd = (symbol: string) => {
            const f = feeds?.find((x) => x.symbol === symbol);
            return f ? Number(f.price) * Math.pow(10, f.expo) : null;
        };
        const deep = usd("DEEP");
        const sui = usd("SUI");
        if (deep !== null && sui !== null && sui !== 0) return deep / sui;
    } catch {
        /* fall through to the pin-era constant */
    }
    return 0.0234;
};

// ---------------------------------------------------------------------------
const main = async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
        deepbook: {
            packages: { deepbook: { latestId: string } };
            pools: Record<
                string,
                {
                    objectId: string;
                    initialSharedVersion: string;
                    baseType: string;
                    quoteType: string;
                }
            >;
        };
    };
    const pkg = manifest.deepbook.packages.deepbook.latestId;
    const pool = manifest.deepbook.pools.DEEP_SUI;
    if (!pool) return fail("manifest has no DEEP_SUI pool pin");

    const rpc = forkRpcUrl();
    log(`fork RPC: ${rpc}`);
    const core = new SuiGrpcClient({ network: "mainnet", baseUrl: rpc }).core as Core;

    const mid = await pythImpliedMid();
    log(`Pyth-implied DEEP_SUI mid: ${mid.toFixed(6)} SUI/DEEP`);

    const poolRef = (tx: Transaction) =>
        tx.sharedObjectRef({
            objectId: pool.objectId,
            initialSharedVersion: pool.initialSharedVersion,
            mutable: true,
        });

    // Pre-warm the pool's Versioned inner (a dynamic-field child): execution
    // child reads do NOT lazy-fetch on the fork, so the first order would
    // abort in dynamic_field::borrow_child_object without this. The gRPC
    // GetObject below materializes it into the fork's store.
    {
        const poolObj = await core.getObject({
            objectId: pool.objectId,
            include: { content: true },
        });
        const content = poolObj.object?.content;
        if (!content || content.length < 72) return fail("could not read the pool object content");
        const innerUid = `0x${Buffer.from(content.slice(32, 64)).toString("hex")}`;
        const innerVersion = new DataView(content.buffer, content.byteOffset + 64, 8).getBigUint64(
            0,
            true,
        );
        const innerFieldId = deriveDynamicFieldID(
            innerUid,
            "u64",
            bcs.u64().serialize(innerVersion).toBytes(),
        );
        await core
            .getObject({ objectId: innerFieldId })
            .catch(() => fail(`could not pre-warm pool inner ${innerFieldId}`));
    }

    // --- 1. reuse or create+fund a BalanceManager --------------------------
    // The whale's known SUI coin is small and every BM creation+deposit drains
    // it permanently (funds park in the shared BM), so the BM is created ONCE
    // and persisted; reruns reuse it. A fork wipe invalidates the state file —
    // detected by the existence probe below.
    let bm: { objectId: string; version: string } | null = null;
    if (existsSync(STATE_PATH)) {
        const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
            objectId?: string;
            version?: string;
        };
        if (saved.objectId && saved.version) {
            const alive = await core.getObject({ objectId: saved.objectId }).catch(() => null);
            if (alive?.object) {
                bm = { objectId: saved.objectId, version: saved.version };
                log(`reusing BalanceManager ${bm.objectId} (already funded)`);
            } else {
                log("saved BalanceManager not on this fork (wiped?) — creating a fresh one");
            }
        }
    }
    const firstRun = bm === null;
    if (bm === null) {
        log("creating BalanceManager...");
        const gasCreate = await objectRef(core, WHALE_GAS_COIN);
        const txCreate = new Transaction();
        const manager = txCreate.moveCall({ target: `${pkg}::balance_manager::new` });
        txCreate.moveCall({
            target: "0x2::transfer::public_share_object",
            arguments: [manager],
            typeArguments: [`${pkg}::balance_manager::BalanceManager`],
        });
        const createRaw = await execute(core, txCreate, gasCreate, "create BalanceManager");
        bm = findCreatedBalanceManager(createRaw);
        log(`BalanceManager: ${bm.objectId} (initial shared version ${bm.version})`);
    }
    let gas = await objectRef(core, WHALE_GAS_COIN);
    const bmRef = (tx: Transaction) =>
        tx.sharedObjectRef({
            objectId: bm.objectId,
            initialSharedVersion: bm.version,
            mutable: true,
        });

    // --- 2. deposit DEEP + SUI ---------------------------------------------
    // Self-matching returns both legs to the same BalanceManager after every
    // fill (zero fees on the whitelisted pool), so ONE fill's worth of each
    // asset suffices — important for SUI: the whale's known coin holds only a
    // few SUI, and fork-side coin enumeration is stubbed empty so bigger
    // coins can't be discovered.
    const deepDeposit = BigInt(QTY_DEEP * 2) * DEEP_SCALAR;
    const suiDeposit = BigInt(Math.ceil(QTY_DEEP * mid * 1.1 * 1e9));
    if (firstRun) {
        log(`depositing ${deepDeposit / DEEP_SCALAR} DEEP + ${suiDeposit / 1_000_000_000n} SUI...`);
        gas = await objectRef(core, WHALE_GAS_COIN);
        const deepCoin = await objectRef(core, WHALE_DEEP_COIN);
        const txDeposit = new Transaction();
        const [deepChunk] = txDeposit.splitCoins(txDeposit.objectRef(deepCoin), [
            txDeposit.pure.u64(deepDeposit),
        ]);
        txDeposit.moveCall({
            target: `${pkg}::balance_manager::deposit`,
            arguments: [bmRef(txDeposit), deepChunk],
            typeArguments: [pool.baseType],
        });
        const [suiChunk] = txDeposit.splitCoins(txDeposit.gas, [txDeposit.pure.u64(suiDeposit)]);
        txDeposit.moveCall({
            target: `${pkg}::balance_manager::deposit`,
            arguments: [bmRef(txDeposit), suiChunk],
            typeArguments: [pool.quoteType],
        });
        await execute(core, txDeposit, gas, "deposit DEEP+SUI");
        // Persist only a FUNDED manager — recording it before the deposit would
        // make every later run reuse an empty one.
        writeFileSync(STATE_PATH, JSON.stringify(bm, null, 4) + "\n");
    }

    // --- 2b. top up the manager's SUI from the whale's coin ----------------
    // Fills recycle SUI within each batch, but the manager needs one fill's
    // worth up-front and the whale's known coin is nearly drained — deposit
    // whatever it holds beyond a gas reserve.
    {
        const gasObj = await core.getObject({
            objectId: WHALE_GAS_COIN,
            include: { content: true },
        });
        const content = gasObj.object?.content;
        const gasBal = content
            ? new DataView(content.buffer, content.byteOffset + 32, 8).getBigUint64(0, true)
            : 0n;
        const reserve = 400_000_000n; // 0.4 SUI for remaining gas budgets
        if (gasBal > reserve + 100_000_000n) {
            const topUp = gasBal - reserve;
            log(`topping up manager SUI by ${Number(topUp) / 1e9}...`);
            gas = await objectRef(core, WHALE_GAS_COIN);
            const txTop = new Transaction();
            const [suiChunk] = txTop.splitCoins(txTop.gas, [txTop.pure.u64(topUp)]);
            txTop.moveCall({
                target: `${pkg}::balance_manager::deposit`,
                arguments: [bmRef(txTop), suiChunk],
                typeArguments: [pool.quoteType],
            });
            await execute(core, txTop, gas, "top up SUI");
        }
    }

    // --- 3. position the fork clock ----------------------------------------
    // The fork clock starts at the FORK_CHECKPOINT pin (days in the past), so
    // fills would be timestamped outside every "last 24h" server window
    // (/ticker, /ohclv defaults) and never show up. Jump to slightly LESS
    // than now — batches then advance towards wall time so every fill lands
    // in the visible past, spread across candle buckets. The clock only
    // moves forward, so a rerun that finds it at/ahead of wall time simply
    // clusters its fills near now.
    const wallNow = BigInt(Date.now());
    const chainNow = await clockNowMs(core);
    const target = wallNow - BigInt((BATCHES + 1) * CANDLE_STEP_MS);
    if (chainNow < target) {
        log(
            `advancing fork clock ${((target - chainNow) / 3_600_000n).toString()}h to ${new Date(
                Number(target),
            ).toISOString()}...`,
        );
        advanceClockBy(target - chainNow);
    }

    // --- 4. trade batches: self-fills INSIDE the mainnet spread ------------
    // Crossing the real book works (verified) but the pin-era bid book has a
    // maker whose account state can't be materialized — every sell that
    // reaches it aborts. Instead each batch places a bid INSIDE the spread
    // (above every real bid, below every real ask) and an IOC ask at the
    // same price: a pure self-fill (allowed by SELF_MATCHING_ALLOWED) that
    // never touches foreign makers and recycles the scarce SUI in-tx. The
    // price walks a few ticks so candles show structure.
    const qty = BigInt(QTY_DEEP) * DEEP_SCALAR;
    const SPREAD_TICKS = [2336n, 2337n, 2338n, 2339n, 2338n, 2337n]; // ×1e7 = inside the DEEP_SUI spread
    let filled = 0;
    for (let i = 0; i < BATCHES; i += 1) {
        if (i > 0) {
            // Advance one candle bucket, but never past wall time — future
            // timestamps are invisible to the server's windowed queries.
            const chain = await clockNowMs(core);
            const room = BigInt(Date.now()) - chain;
            advanceClockBy(room > BigInt(CANDLE_STEP_MS) ? BigInt(CANDLE_STEP_MS) : 1n);
        }
        const priceU64 = SPREAD_TICKS[i % SPREAD_TICKS.length]! * TICK_SIZE;
        gas = await objectRef(core, WHALE_GAS_COIN);
        const tx = new Transaction();
        const proof = tx.moveCall({
            target: `${pkg}::balance_manager::generate_proof_as_owner`,
            arguments: [bmRef(tx)],
        });
        // Reclaim the previous batch's parked fill proceeds first.
        tx.moveCall({
            target: `${pkg}::pool::withdraw_settled_amounts`,
            arguments: [poolRef(tx), bmRef(tx), proof],
            typeArguments: [pool.baseType, pool.quoteType],
        });
        const order = (isBid: boolean, orderType: number, clientOrderId: bigint) =>
            tx.moveCall({
                target: `${pkg}::pool::place_limit_order`,
                arguments: [
                    poolRef(tx),
                    bmRef(tx),
                    proof,
                    tx.pure.u64(clientOrderId),
                    tx.pure.u8(orderType),
                    tx.pure.u8(0), // SELF_MATCHING_ALLOWED
                    tx.pure.u64(priceU64),
                    tx.pure.u64(qty),
                    tx.pure.bool(isBid),
                    tx.pure.bool(false), // whitelisted pool: no DEEP fees
                    tx.pure.u64(MAX_TIMESTAMP),
                    tx.object.clock(),
                ],
                typeArguments: [pool.baseType, pool.quoteType],
            });
        order(true, 0, BigInt(i * 2 + 1)); // resting bid inside the spread (NO_RESTRICTION)
        order(false, 1, BigInt(i * 2 + 2)); // IOC ask at the same price -> self-fill
        // A batch can still hit an unmaterialized corner of mainnet state —
        // skip it, keep seeding.
        try {
            await execute(core, tx, gas, `trade batch ${i + 1}/${BATCHES}`);
            filled += 1;
            log(
                `batch ${i + 1}/${BATCHES}: self-fill ${QTY_DEEP} DEEP @ ${(
                    Number(priceU64) / Number(PRICE_MULT)
                ).toFixed(6)}`,
            );
        } catch (cause) {
            log(`batch ${i + 1}/${BATCHES}: skipped (${String(cause).slice(0, 160)})`);
        }
    }
    if (filled === 0)
        return fail(
            "no batch executed — nothing to index (a stale .seed-trades-state.json pointing at an unfunded/wiped BalanceManager is the usual cause; delete it and rerun)",
        );

    // --- 5. aggregate candles ----------------------------------------------
    // The server's /ohclv reads the ohclv_1m/ohclv_1d tables, which
    // production fills via a scheduled `CALL update_all_ohclv()` this stack
    // doesn't run —
    // call it here with an explicit full range (the default window skips
    // anything the fork clock stamped ahead of the DB's wall clock).
    log("aggregating OHLCV buckets...");
    execFileSync(
        "docker",
        [
            "exec",
            "deepbook-postgres",
            "psql",
            "-U",
            "postgres",
            "-d",
            "deepbook",
            "-c",
            "CALL update_all_ohclv(1, 99999999999999)",
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
    );

    // --- 6. wait for the indexer to serve the trades -----------------------
    log("waiting for the indexer to ingest the fills...");
    for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`${SERVER_URL}/ohclv/DEEP_SUI`).catch(() => null);
        const candles = res?.ok
            ? ((await res.json()) as { candles?: unknown[] }).candles
            : undefined;
        if (candles && candles.length > 0) {
            log(
                `DONE — ${candles.length} candle(s) served by /ohclv/DEEP_SUI; refresh the dashboard.`,
            );
            return;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    log(
        "trades executed, but /ohclv is still empty after 60s — check `docker compose logs deepbook-indexer`.",
    );
};

await main().catch((cause: unknown) =>
    fail(String(cause instanceof Error ? cause.message : cause)),
);

// Seed demo trades on the fork's DeepBook pools (DEEP_SUI, SUI_USDC,
// DEEP_USDC) so the dashboard's DeepBook page has real candles/ticker data.
//
// Mechanics (all empirically debugged against the fork — see SUI-FORK-NOTES):
//   - Impersonates the DEEP whale via empty-signature `executeTransaction`
//     (the deep-funding.ts path): PTBs are built OFFLINE with concrete object
//     refs — no simulation, which the fork doesn't serve (SEDEFI-358).
//   - Pre-warms the pool's Versioned inner by id first: execution-path child
//     reads do NOT lazy-fetch on the fork, so the first order would abort in
//     dynamic_field::borrow_child_object without it.
//   - Setup: create+share a BalanceManager (persisted in
//     .seed-trades-state.json and reused — the whale's known SUI coin is
//     nearly empty, so parked BM funds must not leak); deposits are computed
//     per selected pool (DEEP from the whale coin, SUI from its gas coin,
//     USDC minted via the boot-configured MintCap, sponsored by the whale).
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
// Fees: DEEP_SUI is whitelisted (zero fees); SUI_USDC and DEEP_USDC are not,
// and their input-token fees leak a little per fill — expect some later
// batches to skip with balance-too-low until the next run's top-up. Trades
// are demo data — this script is manual, not part of `deploy-all`.
//
// Run (stack must be up): pnpm exec tsx scripts/seed-trades.ts
// Knobs: TRADE_POOLS (default "DEEP_SUI,SUI_USDC,DEEP_USDC" — manifest pool
//        names, seeded sequentially so the scarce funds recycle between
//        pools), TRADE_BATCHES per pool (default 8 — note a rerun soon after
//        a successful one finds the fork clock already at wall time, so its
//        fills cluster into one candle bucket instead of one per batch;
//        spread returns once wall time moves on), TRADE_STEP_MS (fork-clock
//        ms between batches, default 60000 = one 1m candle bucket per batch
//        while staying behind wall time), TRADE_TICK_BIAS (signed tick shift
//        applied to every pool's price grid — probe tool for hostile book
//        regions), FORK_RPC_URL (overrides
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
// Spacing between batches in fork-clock time. 60s = one 1m candle bucket per
// batch AND (unlike wider steps) the clock stays behind wall time, so fills
// are visible the moment they index instead of after a catch-up lag.
const CANDLE_STEP_MS = Number(process.env.TRADE_STEP_MS ?? 60_000);

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

const buildImpersonationBytes = async (
    tx: Transaction,
    gas: ObjectRef,
    sender: string = WHALE,
): Promise<Uint8Array> => {
    tx.setSender(sender);
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
    sender: string = WHALE,
): Promise<unknown> => {
    const bytes = await buildImpersonationBytes(tx, gas, sender);
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

/** Oracle USD prices from the dashboard's Pyth feeds, with pin-era fallbacks. */
const pythUsd = async (): Promise<Record<string, number>> => {
    const fallback: Record<string, number> = { DEEP: 0.0162, SUI: 0.692, USDC: 1.0 };
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
        for (const feed of feeds ?? []) {
            const value = Number(feed.price) * Math.pow(10, feed.expo);
            if (Number.isFinite(value) && value > 0) fallback[feed.symbol] = value;
        }
    } catch {
        /* pin-era fallbacks stand */
    }
    return fallback;
};

const coinSymbol = (coinType: string): string => coinType.split("::").pop() ?? coinType;

// Circle stablecoin framework pins (same as devstack-plugins/usdc-funding.ts).
const STABLECOIN_PACKAGE = "0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8";
const USDC_TREASURY = {
    objectId: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    initialSharedVersion: "313333795",
    mutable: true,
};
const DENY_LIST = {
    objectId: "0x0000000000000000000000000000000000000000000000000000000000000403",
    initialSharedVersion: "65624845",
    mutable: true,
};
const MASTER_MINTER =
    process.env.USDC_MINTER_ADDRESS ??
    "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";

/** Balance held by the manager for `coinType` (0n when the field is absent).
 *  The balances live in a Bag whose UID sits at bytes 64..96 of the manager;
 *  keys are `BalanceKey<T>` at the ORIGINAL package id with the hidden
 *  `dummy_field: bool` an empty Move struct carries (BCS = [0]). */
const readBmBalance = async (
    core: Core,
    bmId: string,
    originalPkg: string,
    coinType: string,
): Promise<bigint> => {
    const bmObj = await core.getObject({ objectId: bmId, include: { content: true } });
    const content = bmObj.object?.content;
    if (!content || content.length < 96) return 0n;
    const bagUid = `0x${Buffer.from(content.slice(64, 96)).toString("hex")}`;
    const fieldId = deriveDynamicFieldID(
        bagUid,
        `${originalPkg}::balance_manager::BalanceKey<${coinType}>`,
        new Uint8Array([0]),
    );
    try {
        const field = await core.getObject({ objectId: fieldId, include: { content: true } });
        const bytes = field.object?.content;
        if (!bytes || bytes.length < 41) return 0n;
        return new DataView(bytes.buffer, bytes.byteOffset + 33, 8).getBigUint64(0, true);
    } catch {
        return 0n;
    }
};

/** Mint USDC to the whale via the boot-configured MintCap (a fork-local object
 *  owned by Circle's master-minter — discovered by enumeration, which works
 *  for fork-local objects). Sponsored: sender = master-minter, gas = whale. */
const mintUsdcToWhale = async (core: Core, usdcType: string, amount: bigint): Promise<void> => {
    const owned = await core.listOwnedObjects({ owner: MASTER_MINTER });
    const cap = (owned.objects ?? []).find((o) => (o.type ?? "").includes("::treasury::MintCap<"));
    if (!cap) {
        return fail(
            "no MintCap owned by the master-minter on this fork — boot funding never configured one (fresh fork?); run pnpm deploy-all first",
        );
    }
    const gas = await objectRef(core, WHALE_GAS_COIN);
    const capRef = await objectRef(core, cap.objectId);
    const tx = new Transaction();
    tx.moveCall({
        target: `${STABLECOIN_PACKAGE}::treasury::mint`,
        typeArguments: [usdcType],
        arguments: [
            tx.sharedObjectRef(USDC_TREASURY),
            tx.objectRef(capRef),
            tx.sharedObjectRef(DENY_LIST),
            tx.pure.u64(amount),
            tx.pure.address(WHALE),
        ],
    });
    await execute(core, tx, gas, "mint USDC", MASTER_MINTER);
};

// ---------------------------------------------------------------------------
const main = async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
        deepbook: {
            packages: { deepbook: { originalId: string; latestId: string } };
            pools: Record<
                string,
                {
                    objectId: string;
                    initialSharedVersion: string;
                    baseType: string;
                    quoteType: string;
                    tickSize: number;
                }
            >;
        };
    };
    const pkg = manifest.deepbook.packages.deepbook.latestId;
    const origPkg = manifest.deepbook.packages.deepbook.originalId;

    const SEED_POOLS = (process.env.TRADE_POOLS ?? "DEEP_SUI,SUI_USDC,DEEP_USDC")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    /** Per-coin decimals for the manifest's pool assets. */
    const DECIMALS: Record<string, number> = { DEEP: 6, SUI: 9, USDC: 6 };
    /** Base quantity per fill, in base units — sized so the transient quote
     *  lock fits the manager's scarce SUI (pools run sequentially and every
     *  self-fill settles back, so only one pool's needs are live at a time). */
    const POOL_QTY: Record<string, bigint> = {
        DEEP_SUI: 40_000_000n, // 40 DEEP
        DEEP_USDC: 40_000_000n, // 40 DEEP
        SUI_USDC: 1_000_000_000n, // 1 SUI (the pool's min size)
    };

    const rpc = forkRpcUrl();
    log(`fork RPC: ${rpc}`);
    const core = new SuiGrpcClient({ network: "mainnet", baseUrl: rpc }).core as Core;

    const usd = await pythUsd();

    // --- 1. reuse or create a BalanceManager -------------------------------
    // Created ONCE and persisted — the whale's known SUI coin is nearly empty
    // and funds parked in the shared manager would leak on every recreation.
    // A fork wipe invalidates the state file (existence probe below).
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
                log(`reusing BalanceManager ${bm.objectId}`);
            } else {
                log("saved BalanceManager not on this fork (wiped?) — creating a fresh one");
            }
        }
    }
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
        writeFileSync(STATE_PATH, JSON.stringify(bm, null, 4) + "\n");
    }
    const bmFinal = bm;
    const bmRef = (tx: Transaction) =>
        tx.sharedObjectRef({
            objectId: bmFinal.objectId,
            initialSharedVersion: bmFinal.version,
            mutable: true,
        });

    // --- 2. per-pool funding helper ----------------------------------------
    // Called before EACH pool's batches (not once up-front): input-token fees
    // on the non-whitelisted pools leak a little per fill, so a later pool
    // can be short even though the up-front math covered it.
    const ensureFunded = async (needs: Map<string, bigint>) => {
        for (const [coinType, needed] of needs) {
            const have = await readBmBalance(core, bmFinal.objectId, origPkg, coinType);
            if (have >= needed) continue;
            const shortfall = needed - have;
            const sym = coinSymbol(coinType);
            log(
                `funding manager: +${shortfall.toString()} ${sym} base units (have ${have.toString()})`,
            );
            let gas = await objectRef(core, WHALE_GAS_COIN);
            const tx = new Transaction();
            if (sym === "SUI") {
                const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(shortfall)]);
                tx.moveCall({
                    target: `${pkg}::balance_manager::deposit`,
                    arguments: [bmRef(tx), chunk],
                    typeArguments: [coinType],
                });
            } else if (sym === "DEEP") {
                const deepCoin = await objectRef(core, WHALE_DEEP_COIN);
                const [chunk] = tx.splitCoins(tx.objectRef(deepCoin), [tx.pure.u64(shortfall)]);
                tx.moveCall({
                    target: `${pkg}::balance_manager::deposit`,
                    arguments: [bmRef(tx), chunk],
                    typeArguments: [coinType],
                });
            } else if (sym === "USDC") {
                await mintUsdcToWhale(core, coinType, shortfall + 10_000_000n);
                // Pick a coin that actually covers the split — the whale may hold
                // dust coins from earlier probes.
                const coins = await core.listCoins({ owner: WHALE, coinType });
                let fundingCoin: string | null = null;
                for (const candidate of coins.objects ?? []) {
                    const obj = await core.getObject({
                        objectId: candidate.objectId,
                        include: { content: true },
                    });
                    const bytes = obj.object?.content;
                    if (!bytes || bytes.length < 40) continue;
                    const bal = new DataView(bytes.buffer, bytes.byteOffset + 32, 8).getBigUint64(
                        0,
                        true,
                    );
                    if (bal >= shortfall) {
                        fundingCoin = candidate.objectId;
                        break;
                    }
                }
                if (!fundingCoin)
                    return fail("minted USDC but found no whale coin covering the deposit");
                const coinRef = await objectRef(core, fundingCoin);
                const [chunk] = tx.splitCoins(tx.objectRef(coinRef), [tx.pure.u64(shortfall)]);
                tx.moveCall({
                    target: `${pkg}::balance_manager::deposit`,
                    arguments: [bmRef(tx), chunk],
                    typeArguments: [coinType],
                });
            } else {
                return fail(`no funding source for ${coinType}`);
            }
            await execute(core, tx, gas, `deposit ${sym}`);
        }
    };

    // --- 3. position the fork clock ----------------------------------------
    // The fork clock starts at the FORK_CHECKPOINT pin (days in the past), so
    // fills would be timestamped outside every "last 24h" server window and
    // never show up. Jump to slightly LESS than now — batches then advance
    // towards wall time so every fill lands in the visible past. The clock
    // only moves forward; a rerun that finds it at wall time clusters fills.
    const totalBatches = SEED_POOLS.length * BATCHES;
    const wallNow = BigInt(Date.now());
    const chainNow = await clockNowMs(core);
    const target = wallNow - BigInt((totalBatches + 1) * CANDLE_STEP_MS);
    if (chainNow < target) {
        log(`advancing fork clock to ${new Date(Number(target)).toISOString()}...`);
        advanceClockBy(target - chainNow);
    }

    // --- 4. per pool: prewarm, then self-fill batches inside the spread ----
    let totalFilled = 0;
    for (const name of SEED_POOLS) {
        const pin = manifest.deepbook.pools[name]!;
        const qty = POOL_QTY[name] ?? 10_000_000n;
        const baseSym = coinSymbol(pin.baseType);
        const quoteSym = coinSymbol(pin.quoteType);
        const baseDec = DECIMALS[baseSym] ?? 9;
        const quoteDec = DECIMALS[quoteSym] ?? 9;
        const mid = (usd[baseSym] ?? 1) / (usd[quoteSym] ?? 1);
        // Top up this pool's transient needs (bid lock + base leg + margin).
        const poolNeeds = new Map<string, bigint>();
        poolNeeds.set(pin.baseType, (qty * 23n) / 20n);
        poolNeeds.set(
            pin.quoteType,
            BigInt(Math.ceil(Number(qty) * mid * Math.pow(10, quoteDec - baseDec) * 1.15)),
        );
        await ensureFunded(poolNeeds);
        // DeepBook order price = float × 1e9 × 10^quoteDec / 10^baseDec.
        const priceMult = 10n ** BigInt(9 + quoteDec - baseDec);
        const tick = BigInt(pin.tickSize);
        const centerTicks =
            BigInt(Math.round((mid * Number(priceMult)) / Number(tick))) +
            BigInt(process.env.TRADE_TICK_BIAS ?? 0);
        // Small walk around the oracle mid — inside the spread on a calm
        // book; a batch that reaches hostile/unmaterialized book state is
        // skipped, not fatal.
        const OFFSETS = [-2n, -1n, 0n, 1n, 2n, 1n, 0n, -1n];

        // Pre-warm the pool's Versioned inner (a dynamic-field child):
        // execution child reads do NOT lazy-fetch on the fork.
        const poolObj = await core.getObject({
            objectId: pin.objectId,
            include: { content: true },
        });
        const content = poolObj.object?.content;
        if (!content || content.length < 72) return fail(`could not read pool object for ${name}`);
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
            .catch(() => fail(`could not pre-warm pool inner for ${name}`));

        const poolRef = (tx: Transaction) =>
            tx.sharedObjectRef({
                objectId: pin.objectId,
                initialSharedVersion: pin.initialSharedVersion,
                mutable: true,
            });

        let filled = 0;
        for (let i = 0; i < BATCHES; i += 1) {
            if (totalFilled + i > 0) {
                // One candle bucket per batch, capped at wall time — future
                // timestamps are invisible to the server's windowed queries.
                const chain = await clockNowMs(core);
                const room = BigInt(Date.now()) - chain;
                advanceClockBy(room > BigInt(CANDLE_STEP_MS) ? BigInt(CANDLE_STEP_MS) : 1n);
            }
            const priceU64 = (centerTicks + OFFSETS[i % OFFSETS.length]!) * tick;
            const gas = await objectRef(core, WHALE_GAS_COIN);
            const tx = new Transaction();
            const proof = tx.moveCall({
                target: `${pkg}::balance_manager::generate_proof_as_owner`,
                arguments: [bmRef(tx)],
            });
            // Reclaim the previous batch's parked fill proceeds first.
            tx.moveCall({
                target: `${pkg}::pool::withdraw_settled_amounts`,
                arguments: [poolRef(tx), bmRef(tx), proof],
                typeArguments: [pin.baseType, pin.quoteType],
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
                        tx.pure.bool(false), // fees in input token (zero on whitelisted pools)
                        tx.pure.u64(MAX_TIMESTAMP),
                        tx.object.clock(),
                    ],
                    typeArguments: [pin.baseType, pin.quoteType],
                });
            order(true, 0, BigInt(i * 2 + 1)); // resting bid inside the spread
            order(false, 1, BigInt(i * 2 + 2)); // IOC ask at the same price -> self-fill
            try {
                await execute(core, tx, gas, `${name} batch ${i + 1}/${BATCHES}`);
                filled += 1;
                log(
                    `${name} ${i + 1}/${BATCHES}: self-fill @ ${(
                        Number(priceU64) / Number(priceMult)
                    ).toFixed(6)}`,
                );
            } catch (cause) {
                log(`${name} ${i + 1}/${BATCHES}: skipped (${String(cause).slice(0, 140)})`);
            }
        }
        totalFilled += filled;
        log(`${name}: ${filled}/${BATCHES} fills`);
    }
    if (totalFilled === 0)
        return fail(
            "no batch executed — nothing to index (a stale .seed-trades-state.json pointing at an unfunded/wiped BalanceManager is the usual cause; delete it and rerun)",
        );

    // --- 5. aggregate candles ----------------------------------------------
    // The server's /ohclv reads the ohclv_1m/ohclv_1d tables, which
    // production fills via a scheduled `CALL update_all_ohclv()` this stack
    // doesn't run — call it with an explicit full range (the default window
    // skips anything the fork clock stamped ahead of the DB's wall clock).
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
        const first = SEED_POOLS[0]!;
        const res = await fetch(`${SERVER_URL}/ohclv/${first}`).catch(() => null);
        const candles = res?.ok
            ? ((await res.json()) as { candles?: unknown[] }).candles
            : undefined;
        if (candles && candles.length > 0) {
            log(
                `DONE — candles served; refresh the dashboard (fills ahead of wall time appear as it catches up).`,
            );
            return;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    log("trades executed; candles appear once wall time passes their fork-clock stamps.");
};

await main().catch((cause: unknown) =>
    fail(String(cause instanceof Error ? cause.message : cause)),
);

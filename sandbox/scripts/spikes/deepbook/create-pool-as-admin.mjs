#!/usr/bin/env node

// DeepBook admin cap impersonation spike.
//
// Validates that empty-signature impersonation on a sui-fork mainnet network
// lets us call admin-gated DeepBook entrypoints by "being" the address that
// owns the DeepbookAdminCap on mainnet. Load-bearing for the production
// sandbox, which needs `createFreshSandboxPool` for any integration test
// that assumes a clean empty pool, and that helper relies on admin cap
// impersonation.
//
// The exercise is to call `pool::create_pool_admin<Base, Quote>(registry,
// tick_size, lot_size, min_size, whitelisted, stable, &cap, ctx)` for a
// pair that does NOT already exist on mainnet, with the cap owner declared
// as sender. Default base/quote: BETH/SUI (BETH is in DeepBook's supported-
// coins list but no BETH/SUI pool exists today, so the call won't abort on
// duplicate-pool).
//
// RPC note: this sui-fork build serves the modern gRPC API, not legacy
// JSON-RPC, so the script reads objects through the `sui` CLI (gRPC) rather
// than `fetch`-ing `sui_getObject` (which 404s). The CLI must be the exact
// same monorepo build as sui-fork, or execute-signed-tx fails with an h2
// stream reset.
//
// Flow:
//   1. `inspect` — read the DeepbookAdminCap + registry objects via the `sui`
//      CLI and print owner / type. Run this first to verify the seed worked
//      and the env vars match.
//   2. `ptb-args` / `build` — assemble the PTB without submitting.
//   3. `submit` — build + execute-signed-tx with no signatures, sui-fork
//      executes the call as the declared (cap-owning) sender.

import { spawnSync } from "node:child_process";
import process from "node:process";

const CONFIG = {
    suiBin: resolveSuiBin(),

    // Verified mainnet 2026-05-18 from
    // https://docs.sui.io/standards/deepbookv3/contract-information
    deepbookPackageId:
        process.env.DEEPBOOK_PACKAGE_ID ||
        "0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497",
    registryId:
        process.env.DEEPBOOK_REGISTRY_ID ||
        "0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d",

    // adminCapId: the DeepbookAdminCap, created in the v1 publish tx
    // (DCgz4D66b1L5vdG6pDuZB4YSDk3eUshGJLgqzNj5upWF).
    // adminCapOwner: its CURRENT owner. The cap was transferred away from the
    // original publisher (0xbd1d25f4…) to 0xd0ec0b2… — verified on mainnet
    // (sui_getObject) and on a correctly-seeded fork. Always `inspect` to confirm:
    // a STALE/unseeded fork serves the cap's *genesis* owner (0xbd1d25f4…), which
    // is wrong and will fail with a sender-mismatch. See README "sui-fork bug".
    adminCapId:
        process.env.DEEPBOOK_ADMIN_CAP_ID ||
        "0xada554b8b712556b8509be47ac1bc04db9505c3532049a543721aca0c010a840",
    adminCapOwner:
        process.env.DEEPBOOK_ADMIN_CAP_OWNER ||
        "0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e",

    // Default test pair: BETH/SUI. Neither pool exists on mainnet today
    // (verified against the supported-coins / pools tables in the
    // deepbookv3 contract-information docs as of 2026-05-18), so the
    // create-pool call won't abort on EPoolAlreadyExists.
    baseType:
        process.env.BASE_TYPE ||
        "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH",
    quoteType: process.env.QUOTE_TYPE || "0x2::sui::SUI",

    // Default pool params (mirror the BETH/USDC pool's, which is a
    // reasonable shape for a BETH-denominated pair).
    tickSize: BigInt(process.env.TICK_SIZE || "1000"),
    lotSize: BigInt(process.env.LOT_SIZE || "10000"),
    minSize: BigInt(process.env.MIN_SIZE || "100000"),
    whitelisted: (process.env.WHITELISTED || "false").toLowerCase() === "true",
    stable: (process.env.STABLE || "false").toLowerCase() === "true",

    // Optional explicit SUI gas coin owned by adminCapOwner, referenced by id.
    // If unset, `build`/`submit` auto-fund the owner from the SUI donor below
    // (the owner holds no enumerable SUI on a fresh fork, so PTB gas
    // auto-selection fails with "Cannot find gas coin").
    adminGasCoin: process.env.DEEPBOOK_ADMIN_GAS_COIN || null,

    // SUI source used to fund the gas-less cap owner on the fork. Referenced by
    // id because a fresh fork can't enumerate the donor's un-fetched mainnet
    // coins. Same whale donor as the deep/usdc spikes.
    suiDonor:
        process.env.SUI_DONOR ||
        "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d",
    donorGasCoin:
        process.env.SUI_DONOR_GAS_COIN ||
        "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714",
    fundAmount: process.env.FUND_AMOUNT || "1000000000", // 1 SUI to the cap owner

    gasBudget: BigInt(process.env.GAS_BUDGET || "200000000"),
};

const MODES = ["build", "submit", "ptb-args", "inspect"];
const mode = process.argv[2] || "build";

if (!MODES.includes(mode)) {
    console.error(`Usage: node create-pool-as-admin.mjs [${MODES.join("|")}]`);
    process.exit(2);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});

async function main() {
    assertForkReachable();

    if (mode === "inspect") {
        const adminCap = fetchObject(CONFIG.adminCapId);
        const registry = fetchObject(CONFIG.registryId);
        process.stdout.write(
            JSON.stringify(
                {
                    adminCap: summarizeObject(CONFIG.adminCapId, adminCap),
                    registry: summarizeObject(CONFIG.registryId, registry),
                    config: serializableConfig(),
                },
                null,
                2,
            ) + "\n",
        );
        return;
    }

    if (mode === "ptb-args") {
        // Print-only: don't resolve/fund gas (avoid a side effect just to show args).
        process.stdout.write(JSON.stringify(buildPtbArgs(CONFIG.adminGasCoin), null, 2));
        return;
    }

    // build / submit need a real gas coin; fund the cap owner if it has none.
    const gasCoin = ensureGas(CONFIG.adminCapOwner);
    const txBytes = run(CONFIG.suiBin, buildPtbArgs(gasCoin)).stdout.trim();
    if (!txBytes) {
        throw new Error("sui client ptb returned no transaction bytes");
    }

    if (mode === "build") {
        process.stdout.write(txBytes);
        return;
    }

    const submit = run(CONFIG.suiBin, [
        "client",
        "execute-signed-tx",
        "--tx-bytes",
        txBytes,
        "--json",
    ]);
    process.stdout.write(submit.stdout.endsWith("\n") ? submit.stdout : submit.stdout + "\n");

    // `execute-signed-tx` exits 0 even when the tx executes-but-aborts, so the CLI
    // status above won't have thrown. Surface a Move abort as a failure here.
    let eff;
    try {
        eff = JSON.parse(submit.stdout);
    } catch {
        /* non-JSON output already printed; nothing to assert */
    }
    const status = eff?.effects?.status?.status;
    if (status && status !== "success") {
        throw new Error(`create_pool_admin did not succeed: ${JSON.stringify(eff.effects.status)}`);
    }
}

// Read an object via the `sui` CLI (gRPC). Legacy JSON-RPC `sui_getObject`
// 404s on this sui-fork build. Returns null if the object can't be read.
function fetchObject(objectId) {
    const r = spawnSync(CONFIG.suiBin, ["client", "object", objectId, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    try {
        return JSON.parse(r.stdout);
    } catch {
        return null;
    }
}

function summarizeObject(objectId, data) {
    return {
        objectId,
        found: Boolean(data),
        owner: data?.owner,
        type: data?.objType ?? data?.type,
        version: data?.version,
    };
}

// Ensure `addr` owns a SUI gas coin, funding it from the donor if not. Returns
// the gas coin id. An explicit DEEPBOOK_ADMIN_GAS_COIN short-circuits this.
function ensureGas(addr) {
    if (CONFIG.adminGasCoin) return CONFIG.adminGasCoin;

    let coin = findGasCoin(addr);
    if (coin) return coin;

    // The owner holds no enumerable SUI on the fork. Fund it by referencing a
    // known donor coin by id (a fresh fork can't enumerate the donor's coins).
    const donorCoin = CONFIG.donorGasCoin || findGasCoin(CONFIG.suiDonor);
    if (!donorCoin) {
        throw new Error(
            `No SUI source coin. Set DEEPBOOK_ADMIN_GAS_COIN (a coin owned by ${addr}), ` +
                `or SUI_DONOR_GAS_COIN (a coin owned by the donor ${CONFIG.suiDonor}).`,
        );
    }
    console.error(
        `funding cap owner ${addr} with ${CONFIG.fundAmount} MIST from donor ${CONFIG.suiDonor}…`,
    );
    const txBytes = run(CONFIG.suiBin, [
        "client",
        "ptb",
        "--sender",
        `@${CONFIG.suiDonor}`,
        "--gas-coin",
        `@${donorCoin}`,
        "--gas-budget",
        "100000000",
        "--split-coins",
        "gas",
        `[${CONFIG.fundAmount}]`,
        "--assign",
        "funded",
        "--transfer-objects",
        "[funded.0]",
        `@${addr}`,
        "--serialize-unsigned-transaction",
    ]).stdout.trim();
    const eff = JSON.parse(
        run(CONFIG.suiBin, ["client", "execute-signed-tx", "--tx-bytes", txBytes, "--json"]).stdout,
    );
    if (eff?.effects?.status?.status !== "success") {
        throw new Error(`funding tx did not succeed: ${JSON.stringify(eff?.effects?.status)}`);
    }

    // Prefer the freshly-created coin id from effects; fall back to listing.
    for (const c of eff.effects?.created ?? []) {
        const id = c.reference?.objectId;
        const obj = id ? fetchObject(id) : null;
        if (
            obj &&
            (obj.objType || "").includes("::sui::SUI") &&
            (obj.owner?.AddressOwner || "").toLowerCase() === addr.toLowerCase()
        ) {
            return id;
        }
    }
    sleep(0.8);
    coin = findGasCoin(addr, 10);
    if (!coin) throw new Error(`funded ${addr} but could not find its gas coin (fork index lag?)`);
    return coin;
}

// The fork's owned-coins query is intermittent; retry a few times.
function findGasCoin(addr, retries = 6) {
    for (let i = 0; i < retries; i++) {
        const r = spawnSync(CONFIG.suiBin, ["client", "gas", addr, "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 64 * 1024 * 1024,
        });
        if (r.status === 0) {
            try {
                const coins = JSON.parse(r.stdout);
                if (Array.isArray(coins) && coins.length) {
                    let best = coins[0];
                    for (const c of coins)
                        if (BigInt(c.mistBalance) > BigInt(best.mistBalance)) best = c;
                    return best.gasCoinId;
                }
            } catch {
                /* retry */
            }
        }
        if (i < retries - 1) sleep(0.4);
    }
    return null;
}

function buildPtbArgs(gasCoin) {
    const args = ["client", "ptb", "--sender", `@${CONFIG.adminCapOwner}`];
    // Pin the gas coin when known (auto-funded for build/submit; may be null for ptb-args).
    if (gasCoin) args.push("--gas-coin", `@${gasCoin}`);
    args.push(
        "--gas-budget",
        CONFIG.gasBudget.toString(),
        "--move-call",
        `${CONFIG.deepbookPackageId}::pool::create_pool_admin`,
        `<${CONFIG.baseType}, ${CONFIG.quoteType}>`,
        `@${CONFIG.registryId}`,
        CONFIG.tickSize.toString(),
        CONFIG.lotSize.toString(),
        CONFIG.minSize.toString(),
        CONFIG.whitelisted ? "true" : "false",
        CONFIG.stable ? "true" : "false",
        `@${CONFIG.adminCapId}`,
        "--assign",
        "pool_id",
        "--serialize-unsigned-transaction",
    );
    return args;
}

function serializableConfig() {
    return {
        ...CONFIG,
        tickSize: CONFIG.tickSize.toString(),
        lotSize: CONFIG.lotSize.toString(),
        minSize: CONFIG.minSize.toString(),
        gasBudget: CONFIG.gasBudget.toString(),
    };
}

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const stderr = (result.stderr || "").trim();
        const stdout = (result.stdout || "").trim();
        const detail = [stderr, stdout].filter(Boolean).join("\n");
        throw new Error(
            `Command failed (${result.status}): ${command} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
        );
    }

    return result;
}

function sleep(seconds) {
    spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
}

function resolveSuiBin() {
    if (process.env.SUI_BIN) {
        return process.env.SUI_BIN;
    }
    const probe = spawnSync("sui", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) {
        return "sui";
    }
    throw new Error(
        "Could not locate the `sui` binary. Either put it on your PATH or set SUI_BIN to its absolute path.",
    );
}

// Fail fast with a clear message if the fork RPC is unreachable, rather than
// letting object reads return null and surfacing a confusing downstream error.
// sui-fork is ephemeral — it does not survive a reboot or a stale day.
function assertForkReachable() {
    const probe = spawnSync(CONFIG.suiBin, ["client", "chain-identifier"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) return;
    const err = (probe.stderr || probe.stdout || "").trim();
    const envProbe = spawnSync(CONFIG.suiBin, ["client", "active-env"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const activeEnv = (envProbe.stdout || "").trim() || "unknown";
    throw new Error(
        `Cannot reach the Sui fork RPC (active CLI env: ${activeEnv}). Is sui-fork running?\n` +
            `Start it (state does NOT persist across restarts unless you reuse --data-dir), e.g.:\n` +
            `  sui-fork start --network mainnet --data-dir /tmp/sui-fork-deepbook-spike\n` +
            `then point the CLI at it: sui client switch --env local-fork\n` +
            (err ? `Underlying error: ${err}` : ""),
    );
}

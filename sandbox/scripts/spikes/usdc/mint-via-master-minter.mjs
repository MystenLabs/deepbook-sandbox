#!/usr/bin/env node

// DBSF-002 — USDC mint via Circle treasury master-minter impersonation.
//
// VALIDATED end-to-end on a sui-fork mainnet network: this mints fresh native
// USDC (total supply increases) using only empty-signature impersonation — no
// private keys. It replaces the earlier naive `coin::mint` spike, which is
// impossible: Circle's USDC `TreasuryCap` is not address-owned. It lives as a
// dynamic object field under a shared `Treasury<USDC>`, gated by the stablecoin
// framework's controller -> minter allowlist (each minter holds a `MintCap`).
//
// Mechanism (cf. ../pyth + ../deep): `sui client ptb --serialize-unsigned-
// transaction` builds an unsigned PTB with a declared sender; submitting it via
// `sui client execute-signed-tx` with an EMPTY signature list makes sui-fork
// execute as that sender. We impersonate the on-chain master minter to grant
// ourselves a minter, then impersonate that minter to call `treasury::mint`.
//
// Flow (`mint` mode):
//   0. Fund the master minter with SUI for gas (it holds none on-chain) by
//      impersonating a SUI donor (the DEEP whale) — one-time per fork.
//   1. As the master minter: configure_new_controller(treasury, MM, MM) +
//      configure_minter(treasury, denylist, allowance) — creates a MintCap
//      owned by MM and sets its allowance. One-time per fork; the resulting
//      MintCap id can be passed back via USDC_MINT_CAP_ID to skip this step.
//   2. As the master minter (now also the minter): mint(treasury, mintCap,
//      denylist, amount, recipient). Repeatable per faucet request.
//
// The master minter address is a fixed mainnet role; it was discovered on the
// fork by deriving the `MasterMinterKey` dynamic field on the Treasury's Roles
// `Bag` and reading its address value. The derivation (for when Circle rotates
// it, or to automate in DBSF-010/011 where the @mysten/sui SDK is available):
//   bag      = Treasury.contents[112..144]  // UID + 2 Tables(40 each) precede roles.data
//   fieldId  = deriveDynamicFieldID(bag, `${PKG}::roles::MasterMinterKey`, [0x00])
//   address  = Field<MasterMinterKey, address>.contents[33..65]
// NB: the deployed package predates the current GitHub source, so its key
// structs carry a `dummy_field: bool` -> the BCS key bytes are [0x00], not empty.

import { spawnSync } from "node:child_process";
import process from "node:process";

const env = (name, fallback) => process.env[name] || fallback;

const CONFIG = {
    suiBin: resolveSuiBin(),
    // Circle Sui stablecoin framework package (treasury, roles, mint_allowance).
    stablecoinPkg: env(
        "STABLECOIN_PKG",
        "0xecf47609d7da919ea98e7fd04f6e0648a0a79b337aaad373fa37aac8febf19c8",
    ),
    usdcType: env(
        "USDC_COIN_TYPE",
        "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    ),
    // Shared Treasury<USDC> object.
    treasury: env(
        "USDC_TREASURY",
        "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    ),
    // TreasuryCap<USDC> (dynamic-object-field under the Treasury) — read for total supply.
    treasuryCap: env(
        "USDC_TREASURY_CAP_ID",
        "0x677e41a5c35d90177d401b72952c228ffa65b770e265561ad607f34d6896dcc2",
    ),
    // System DenyList shared object.
    denyList: env(
        "DENY_LIST",
        "0x0000000000000000000000000000000000000000000000000000000000000403",
    ),
    // Fixed mainnet master-minter role (see derivation note in the header).
    masterMinter: env(
        "USDC_MASTER_MINTER",
        "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1",
    ),
    // SUI source used to fund the gas-less master minter on the fork.
    suiDonor: env(
        "SUI_DONOR",
        "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d",
    ),
    // A specific SUI coin owned by suiDonor, referenced by id. Required because a
    // fresh fork cannot ENUMERATE the donor's coins (it only lazily fetches state
    // on reference by id) — so `sui client gas <donor>` returns empty until a tx
    // touches them. Defaults to the candidate whale's mainnet SUI coin; override
    // if it has been spent/merged (look it up on an explorer).
    donorGasCoin: env(
        "SUI_DONOR_GAS_COIN",
        "0xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714",
    ),
    recipient: env(
        "RECIPIENT",
        "0x0000000000000000000000000000000000000000000000000000000000000abc",
    ),
    // Optional: reuse a MintCap from a prior `setup`/`mint` run to skip configuration.
    mintCapId: process.env.USDC_MINT_CAP_ID || null,
    mintAmount: BigInt(process.env.MINT_AMOUNT || "1000000000"), // 1000 USDC (6 dp)
    allowance: BigInt(process.env.MINT_ALLOWANCE || "1000000000000000"), // 1e9 USDC headroom
    gasBudget: process.env.GAS_BUDGET || "100000000",
    fundAmount: process.env.FUND_AMOUNT || "1000000000", // 1 SUI to the master minter
};

const MODES = ["inspect", "setup", "mint"];
const mode = process.argv[2] || "mint";

if (!MODES.includes(mode)) {
    console.error(`Usage: node mint-via-master-minter.mjs [${MODES.join("|")}]`);
    process.exit(2);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});

async function main() {
    assertForkReachable();
    const mm = CONFIG.masterMinter;

    if (mode === "inspect") {
        const gasCoin = findGasCoin(mm);
        const cap = CONFIG.mintCapId ? objectJson(CONFIG.mintCapId) : null;
        process.stdout.write(
            JSON.stringify(
                {
                    config: serializableConfig(),
                    masterMinter: mm,
                    totalSupply: totalSupply().toString(),
                    masterMinterGasCoin: gasCoin,
                    masterMinterFunded: Boolean(gasCoin),
                    mintCapValid: Boolean(
                        cap && (cap.objType || "").includes("::treasury::MintCap<"),
                    ),
                },
                null,
                2,
            ) + "\n",
        );
        return;
    }

    const gasCoin = ensureGas(mm);
    const capId = ensureMintCap(mm, gasCoin);

    if (mode === "setup") {
        process.stdout.write(
            JSON.stringify(
                {
                    masterMinter: mm,
                    mintCapId: capId,
                    hint: `reuse with USDC_MINT_CAP_ID=${capId}`,
                },
                null,
                2,
            ) + "\n",
        );
        return;
    }

    // mode === "mint"
    const result = doMint(mm, gasCoin, capId);
    process.stdout.write(
        JSON.stringify(
            {
                digest: result.digest,
                recipient: CONFIG.recipient,
                mintedCoin: result.coin,
                mintAmount: CONFIG.mintAmount.toString(),
                totalSupplyBefore: result.before.toString(),
                totalSupplyAfter: result.after.toString(),
                supplyDelta: result.delta.toString(),
                mintCapId: capId,
                reuseHint: `set USDC_MINT_CAP_ID=${capId} to skip configuration next run`,
            },
            null,
            2,
        ) + "\n",
    );
}

// Ensure `addr` owns a SUI gas coin, funding it from the donor if not.
function ensureGas(addr) {
    // Fork-local coins enumerate fine (the funded coin is a fork object), so this
    // succeeds on re-runs / already-funded addresses.
    let coin = findGasCoin(addr);
    if (coin) return coin;

    // Fund from the donor. A FRESH fork can't enumerate the donor's un-fetched
    // mainnet coins, so we reference a known donor coin by id (lazily fetched).
    const donorCoin = CONFIG.donorGasCoin || findGasCoin(CONFIG.suiDonor);
    if (!donorCoin) {
        throw new Error(
            `No SUI source coin. Set SUI_DONOR_GAS_COIN to a SUI coin id owned by ${CONFIG.suiDonor} ` +
                "(a fresh fork cannot list the donor's un-fetched mainnet coins).",
        );
    }
    const eff = forkTx(CONFIG.suiDonor, donorCoin, [
        "--split-coins",
        "gas",
        `[${CONFIG.fundAmount}]`,
        "--assign",
        "funded",
        "--transfer-objects",
        "[funded.0]",
        `@${addr}`,
    ]);

    // Prefer the freshly-created coin id straight from effects (deterministic);
    // fall back to listing (the index can briefly lag a just-committed transfer).
    const funded = findCreated(
        eff,
        (obj) =>
            (obj.objType || "").includes("::coin::Coin<") &&
            (obj.objType || "").includes("::sui::SUI") &&
            (obj.owner?.AddressOwner || "").toLowerCase() === addr.toLowerCase(),
    );
    if (funded) return funded;

    sleep(0.8);
    coin = findGasCoin(addr, 10);
    if (!coin)
        throw new Error(`funded ${addr} but still could not find its gas coin (fork index lag?)`);
    return coin;
}

// Reuse a provided MintCap (refreshing allowance), or configure a fresh one.
function ensureMintCap(mm, gasCoin) {
    const pkg = CONFIG.stablecoinPkg;
    const usdc = `<${CONFIG.usdcType}>`;

    if (CONFIG.mintCapId) {
        const cap = objectJson(CONFIG.mintCapId);
        if (cap && (cap.objType || "").includes("::treasury::MintCap<")) {
            // Top the minter's allowance back up so repeated mints don't exhaust it.
            forkTx(mm, gasCoin, [
                "--move-call",
                `${pkg}::treasury::configure_minter`,
                usdc,
                `@${CONFIG.treasury}`,
                `@${CONFIG.denyList}`,
                CONFIG.allowance.toString(),
            ]);
            return CONFIG.mintCapId;
        }
        console.error(
            `warning: USDC_MINT_CAP_ID ${CONFIG.mintCapId} not found / not a MintCap; configuring fresh.`,
        );
    }

    let eff;
    try {
        eff = forkTx(mm, gasCoin, [
            "--move-call",
            `${pkg}::treasury::configure_new_controller`,
            usdc,
            `@${CONFIG.treasury}`,
            `@${mm}`,
            `@${mm}`,
            "--move-call",
            `${pkg}::treasury::configure_minter`,
            usdc,
            `@${CONFIG.treasury}`,
            `@${CONFIG.denyList}`,
            CONFIG.allowance.toString(),
        ]);
    } catch (error) {
        // configure_new_controller aborts if this address is already a controller.
        throw new Error(
            `configure_new_controller failed (the master minter may already be a controller on this fork).\n` +
                `Pass USDC_MINT_CAP_ID=<id> (printed by the earlier setup/mint run) to reuse it, or restart the fork.\n` +
                `Underlying error:\n${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const capId = mintCapFromEffects(eff, mm);
    if (!capId)
        throw new Error("configured controller but could not locate the new MintCap in tx effects");
    return capId;
}

function doMint(mm, gasCoin, capId) {
    const before = totalSupply();
    const eff = forkTx(mm, gasCoin, [
        "--move-call",
        `${CONFIG.stablecoinPkg}::treasury::mint`,
        `<${CONFIG.usdcType}>`,
        `@${CONFIG.treasury}`,
        `@${capId}`,
        `@${CONFIG.denyList}`,
        CONFIG.mintAmount.toString(),
        `@${CONFIG.recipient}`,
    ]);
    const after = totalSupply();
    const created = (eff.effects?.created ?? []).map((c) => c.reference?.objectId).filter(Boolean);
    // Identify the minted Coin<USDC> by type rather than assuming it's created[0].
    const coin =
        findCreated(
            eff,
            (obj) =>
                (obj.objType || "").includes("::coin::Coin<") &&
                (obj.objType || "").includes(CONFIG.usdcType),
        ) ?? created[0];
    return { digest: eff.digest, before, after, delta: after - before, coin, created };
}

// --- fork interaction --------------------------------------------------------

// Build an unsigned PTB and submit it with an empty signature list (impersonation).
function forkTx(sender, gasCoin, ptbBody) {
    const args = [
        "client",
        "ptb",
        "--sender",
        `@${sender}`,
        "--gas-coin",
        `@${gasCoin}`,
        "--gas-budget",
        CONFIG.gasBudget,
        ...ptbBody,
        "--serialize-unsigned-transaction",
    ];
    const txBytes = run(CONFIG.suiBin, args).stdout.trim();
    if (!txBytes.startsWith("A")) {
        throw new Error(`sui client ptb did not return tx bytes:\n${txBytes}`);
    }
    const out = run(CONFIG.suiBin, [
        "client",
        "execute-signed-tx",
        "--tx-bytes",
        txBytes,
        "--json",
    ]).stdout;
    const eff = JSON.parse(out);
    const status = eff?.effects?.status?.status;
    if (status !== "success") {
        throw new Error(
            `tx ${eff?.digest ?? "?"} did not succeed: ${JSON.stringify(eff?.effects?.status)}`,
        );
    }
    return eff;
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
                /* fall through to retry */
            }
        }
        if (i < retries - 1) sleep(0.4);
    }
    return null;
}

function mintCapFromEffects(eff, owner) {
    return findCreated(
        eff,
        (obj) =>
            (obj.objType || "").includes("::treasury::MintCap<") &&
            (obj.owner?.AddressOwner || "").toLowerCase() === owner.toLowerCase(),
    );
}

// Find a created object matching `predicate`, reading each object's full type
// with a small retry (the fork's per-object reads are occasionally flaky).
function findCreated(eff, predicate) {
    for (const c of eff?.effects?.created ?? []) {
        const id = c.reference?.objectId;
        if (!id) continue;
        const obj = objectJsonRetry(id);
        if (obj && predicate(obj, id)) return id;
    }
    return null;
}

// TreasuryCap<T> = { id: UID(32), total_supply: Supply<T> { value: u64 } }.
function totalSupply() {
    const contents = objectContents(CONFIG.treasuryCap);
    if (!Array.isArray(contents) || contents.length < 40) {
        throw new Error(
            `could not read TreasuryCap ${CONFIG.treasuryCap} as a byte array (got ${contents === null ? "null" : `len ${contents?.length}`})`,
        );
    }
    let v = 0n;
    for (let i = 0; i < 8; i++) v += BigInt(contents[32 + i]) << BigInt(8 * i);
    return v;
}

function objectJson(objectId) {
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

function objectJsonRetry(objectId, retries = 4) {
    for (let i = 0; i < retries; i++) {
        const obj = objectJson(objectId);
        if (obj) return obj;
        if (i < retries - 1) sleep(0.3);
    }
    return null;
}

function objectContents(objectId) {
    return objectJsonRetry(objectId)?.content?.Move?.contents ?? null;
}

function serializableConfig() {
    return {
        ...CONFIG,
        mintAmount: CONFIG.mintAmount.toString(),
        allowance: CONFIG.allowance.toString(),
    };
}

// --- process helpers ---------------------------------------------------------

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = [(result.stderr || "").trim(), (result.stdout || "").trim()]
            .filter(Boolean)
            .join("\n");
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
    if (process.env.SUI_BIN) return process.env.SUI_BIN;
    const probe = spawnSync("sui", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) return "sui";
    throw new Error(
        "Could not locate the `sui` binary. Put it on your PATH or set SUI_BIN to its absolute path.",
    );
}

// Fail fast with a clear message if the fork RPC is unreachable, rather than
// letting every object read return null and surfacing a confusing downstream
// error. sui-fork is ephemeral — it does not survive a reboot or a stale day.
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
            `  sui-fork start --network mainnet --data-dir /tmp/sui-fork-usdc-spike\n` +
            `then point the CLI at it: sui client switch --env local-fork\n` +
            (err ? `Underlying error: ${err}` : ""),
    );
}

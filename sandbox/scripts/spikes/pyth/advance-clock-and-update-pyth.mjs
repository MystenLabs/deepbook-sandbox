#!/usr/bin/env node

// advance-clock + Pyth update integration spike.
//
// Validates the clock-drift mitigation strategy for the new oracle-service.
// Stefan's original POC (build-pyth-suiusd-fork-tx.mjs) successfully landed
// a real Hermes VAA on a forked PriceInfoObject, but downstream consumers
// calling pyth::get_price_no_older_than(clock, 60) aborted because the
// forked Clock starts at the fork-checkpoint timestamp and fresh Hermes
// VAAs are stamped "now". Relaxing max_age to 3600s let the read succeed,
// but that diverges from mainnet's 60s freshness contract.
//
// This script proves the proper fix: BEFORE submitting the price update,
// advance the fork's Clock to match the VAA's publish_time. Then the
// 60s freshness check passes because Clock.now ≈ price.publish_time.
//
// Reference loop (the production oracle-service will run this on a timer):
//
//   1. Read current Clock via `sui-fork --json status`
//   2. Fetch the latest Hermes accumulator update for the target feed;
//      note its publish_time
//   3. If publish_time > Clock.now, call `sui-fork advance-clock
//      --duration-ms <delta>` to bring Clock forward
//   4. Submit the Pyth update PTB (parse_and_verify →
//      create_authenticated_price_infos_using_accumulator →
//      update_single_price_feed → hot_potato_vector::destroy)
//   5. (Verification step in this spike, not in production) Submit a
//      read PTB calling pyth::get_price_no_older_than(price_info, clock,
//      60) and assert it succeeds without the 3600s relaxation
//
// Code is intentionally self-contained — the helpers duplicate
// build-pyth-suiusd-fork-tx.mjs so the spike can be read top-to-bottom
// without cross-referencing. The production oracle-service
// will factor out the shared logic.

import { spawnSync } from "node:child_process";
import process from "node:process";

const CONFIG = {
    suiBin: resolveBinary("sui", "SUI_BIN"),
    suiForkBin: resolveBinary("sui-fork", "SUI_FORK_BIN"),
    forkRpcUrl: process.env.FORK_RPC_URL || "http://127.0.0.1:9000",

    // Same defaults as Stefan's POC. Override via env if the Pyth or
    // Wormhole state objects move (e.g., on a future package upgrade).
    pythStateId:
        process.env.PYTH_STATE_ID ||
        "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",
    pythPackageId:
        process.env.PYTH_PACKAGE_ID ||
        "0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91",
    pythTypePrefix:
        process.env.PYTH_TYPE_PREFIX ||
        "0x8d97f1cd6ac663735be08d1d2b6d02a159e711586461306ce60a2b7a6a565a9e",
    wormholeStateId:
        process.env.WORMHOLE_STATE_ID ||
        "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c",
    wormholePackageId:
        process.env.WORMHOLE_PACKAGE_ID ||
        "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a",
    priceInfoObjectId:
        process.env.PRICE_INFO_OBJECT_ID ||
        "0x801dbc2f0053d34734814b2d6df491ce7807a725fe9a01ad74a07e9c51396c37",
    feedId:
        process.env.PYTH_FEED_ID ||
        "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
    sender:
        process.env.SENDER || "0xb4f42571101827758f55a9b998a1251892402fbd4dce90da3373625298091627",
    clockObjectId: process.env.CLOCK_OBJECT_ID || "0x6",
    baseUpdateFee: BigInt(process.env.BASE_UPDATE_FEE || "1"),
    gasBudget: BigInt(process.env.GAS_BUDGET || "200000000"),

    // Gas for the update + verify PTBs. The impersonated `sender` holds no
    // enumerable SUI on a fresh fork, so PTB gas auto-selection fails with
    // "Cannot find gas coin". If SENDER_GAS_COIN is unset, `run` mode funds the
    // sender 1 SUI from the donor below (referenced by id — a fresh fork can't
    // enumerate the donor's un-fetched coins).
    //
    // Donor swapped 2026-08-14 (SEDEFI-317): this used to point at the DEEP
    // whale, whose single SUI coin is now drained to ~0.0997 SUI by the stack's
    // boot funding. Sui rejects a tx whose gas coin holds less than the DECLARED
    // budget before execution, so every run died on "Balance of gas object
    // 99695273 is lower than the needed amount: 100000000". This is the deepbook
    // adminWallet's 5493 SUI coin — the same donor the faucet moved to in the
    // fork-sui-grant plugin, for the same reason.
    senderGasCoin: process.env.SENDER_GAS_COIN || null,
    suiDonor:
        process.env.SUI_DONOR ||
        "0xd0ec0b201de6b4e7f425918bbd7151c37fc1b06c59b3961a2a00db74f6ea865e",
    donorGasCoin:
        process.env.SUI_DONOR_GAS_COIN ||
        "0xd99d6529c67e2330a856e98c141ff57bc8069e36646523ad2f3981cdec8b6f67",
    fundAmount: process.env.FUND_AMOUNT || "1000000000", // 1 SUI to the sender

    // Pyth's default stale_price_threshold. The whole point of this spike
    // is to make the 60s read succeed.
    maxAgeSecs: BigInt(process.env.MAX_AGE_SECS || "60"),
    // Safety margin (ms) added to the advance-clock delta so the new Clock
    // is slightly ahead of publish_time. Without this, Clock.now ==
    // publish_time and the freshness check would still pass with 0s slack,
    // but a tiny margin keeps things robust against any rounding.
    advanceClockSlackMs: BigInt(process.env.ADVANCE_CLOCK_SLACK_MS || "100"),
};

const MODES = ["inspect", "run"];
const mode = process.argv[2] || "inspect";
if (!MODES.includes(mode)) {
    console.error(`Usage: node advance-clock-and-update-pyth.mjs [${MODES.join("|")}]`);
    process.exit(2);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});

async function main() {
    // Step 1 — current Clock (also our fork-reachability preflight)
    let status;
    try {
        status = forkStatus();
    } catch (error) {
        throw new Error(
            `Cannot reach the sui-fork (\`sui-fork status\` at ${CONFIG.forkRpcUrl} failed). ` +
                "Is sui-fork running, and are the `sui` and `sui-fork` binaries the same monorepo build?\n" +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    log("step", {
        name: "status",
        clockMs: status.timestamp_ms,
        checkpoint: status.checkpoint_sequence_number,
    });

    // Step 2 — Hermes fetch
    const hermes = await fetchHermes(CONFIG.feedId);
    const publishTimeMs = BigInt(hermes.publishTimeSeconds) * 1000n;
    log("step", {
        name: "hermes",
        publishTimeMs: publishTimeMs.toString(),
        accumulatorBytes: hermes.accumulatorBytes.length,
    });

    // Step 3 — compute advance-clock delta
    const clockMs = BigInt(status.timestamp_ms);
    const targetMs = publishTimeMs + CONFIG.advanceClockSlackMs;
    const deltaMs = targetMs > clockMs ? targetMs - clockMs : 0n;
    log("step", {
        name: "delta",
        clockMs: clockMs.toString(),
        targetMs: targetMs.toString(),
        deltaMs: deltaMs.toString(),
    });

    if (mode === "inspect") {
        process.stdout.write(
            JSON.stringify(
                {
                    mode: "inspect",
                    clockMs: clockMs.toString(),
                    publishTimeMs: publishTimeMs.toString(),
                    deltaMs: deltaMs.toString(),
                    maxAgeSecs: CONFIG.maxAgeSecs.toString(),
                    config: serializableConfig(),
                    note:
                        "No transactions submitted. Re-run with `run` to advance the clock, " +
                        "submit the Pyth update, and verify with get_price_no_older_than(clock, 60).",
                },
                null,
                2,
            ) + "\n",
        );
        return;
    }

    // `run` mode: ensure the sender can pay gas (fund it from the donor if not).
    const gasCoin = ensureGas(CONFIG.sender);

    // Step 4 — advance the clock (only if needed)
    if (deltaMs > 0n) {
        const advanced = forkAdvanceClock(deltaMs);
        log("step", {
            name: "advance-clock",
            newClockMs: advanced.timestamp_ms,
            txDigest: advanced.tx_digest,
        });
    } else {
        log("step", {
            name: "advance-clock",
            skipped: true,
            reason: "Clock already at or past publish_time",
        });
    }

    // Step 5 — submit the Pyth update
    const updateTxBytes = run(
        CONFIG.suiBin,
        buildUpdatePtbArgs(hermes.accumulatorBytes, hermes.vaaBytes, gasCoin),
    ).stdout.trim();
    if (!updateTxBytes) {
        throw new Error("sui client ptb returned no transaction bytes for the update PTB");
    }
    const updateResult = runJson(CONFIG.suiBin, [
        "client",
        "execute-signed-tx",
        "--tx-bytes",
        updateTxBytes,
        "--json",
    ]);
    const updateDigest = updateResult?.digest || updateResult?.effects?.transactionDigest;
    const updateStatus = updateResult?.effects?.status?.status;
    log("step", { name: "update", digest: updateDigest, status: updateStatus });
    if (updateStatus && updateStatus !== "success") {
        throw new Error(`Pyth update tx failed: ${JSON.stringify(updateResult?.effects?.status)}`);
    }

    // Step 6 — verify the freshness check passes at 60s
    const verifyTxBytes = run(CONFIG.suiBin, buildVerifyPtbArgs(gasCoin)).stdout.trim();
    if (!verifyTxBytes) {
        throw new Error("sui client ptb returned no transaction bytes for the verify PTB");
    }
    const verifyResult = runJson(CONFIG.suiBin, [
        "client",
        "execute-signed-tx",
        "--tx-bytes",
        verifyTxBytes,
        "--json",
    ]);
    const verifyDigest = verifyResult?.digest || verifyResult?.effects?.transactionDigest;
    const verifyStatus = verifyResult?.effects?.status?.status;
    log("step", {
        name: "verify",
        digest: verifyDigest,
        status: verifyStatus,
        maxAgeSecs: CONFIG.maxAgeSecs.toString(),
    });
    if (verifyStatus !== "success") {
        throw new Error(
            `Verification failed at max_age=${CONFIG.maxAgeSecs}s: ` +
                JSON.stringify(verifyResult?.effects?.status),
        );
    }

    process.stdout.write(
        JSON.stringify(
            {
                result: "success",
                clockBeforeMs: clockMs.toString(),
                publishTimeMs: publishTimeMs.toString(),
                clockAdvancedByMs: deltaMs.toString(),
                updateDigest,
                verifyDigest,
                maxAgeSecs: CONFIG.maxAgeSecs.toString(),
            },
            null,
            2,
        ) + "\n",
    );
}

function log(event, payload) {
    console.error(JSON.stringify({ event, ...payload }));
}

function forkStatus() {
    return runJson(CONFIG.suiForkBin, ["--json", "status", "--rpc-addr", CONFIG.forkRpcUrl]);
}

function forkAdvanceClock(durationMs) {
    return runJson(CONFIG.suiForkBin, [
        "--json",
        "advance-clock",
        "--rpc-addr",
        CONFIG.forkRpcUrl,
        "--duration-ms",
        durationMs.toString(),
    ]);
}

async function fetchHermes(feedId) {
    const url = new URL("https://hermes.pyth.network/v2/updates/price/latest");
    url.searchParams.append("ids[]", strip0x(feedId));
    url.searchParams.set("encoding", "hex");
    url.searchParams.set("parsed", "true");

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Hermes request failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    const hex = body?.binary?.data?.[0];
    if (typeof hex !== "string" || hex.length === 0) {
        throw new Error("Hermes response did not contain binary.data[0]");
    }
    const accumulatorBytes = hexToBuffer(hex);
    const vaaBytes = extractVaaBytesFromAccumulatorMessage(accumulatorBytes);

    const parsed = body?.parsed?.[0];
    // Hermes v2 puts publish_time on `parsed[0].price.publish_time`. The
    // `metadata` block contains slot / proof_available_time / prev_publish_time
    // but not publish_time itself in current responses; the fallback is
    // defensive in case the schema shifts.
    const publishTimeSeconds = parsed?.price?.publish_time ?? parsed?.metadata?.publish_time;
    if (typeof publishTimeSeconds !== "number") {
        throw new Error(
            "Hermes response did not contain parsed[0].price.publish_time. " +
                "Ensure the request was made with parsed=true.",
        );
    }

    return { accumulatorBytes, vaaBytes, publishTimeSeconds };
}

function extractVaaBytesFromAccumulatorMessage(accumulatorMessage) {
    if (accumulatorMessage.length < 10) {
        throw new Error("Accumulator message is too short");
    }
    const trailingPayloadSize = accumulatorMessage.readUInt8(6);
    const vaaSizeOffset = 7 + trailingPayloadSize + 1;
    if (vaaSizeOffset + 2 > accumulatorMessage.length) {
        throw new Error("Accumulator message is truncated before VAA size");
    }
    const vaaSize = accumulatorMessage.readUInt16BE(vaaSizeOffset);
    const vaaOffset = vaaSizeOffset + 2;
    const vaaEnd = vaaOffset + vaaSize;
    if (vaaEnd > accumulatorMessage.length) {
        throw new Error("Accumulator message is truncated before VAA payload");
    }
    return accumulatorMessage.subarray(vaaOffset, vaaEnd);
}

function buildUpdatePtbArgs(accumulatorBytes, vaaBytes, gasCoin) {
    return [
        "client",
        "ptb",
        "--sender",
        `@${CONFIG.sender}`,
        "--gas-coin",
        `@${gasCoin}`,
        "--gas-budget",
        CONFIG.gasBudget.toString(),
        "--move-call",
        `${CONFIG.wormholePackageId}::vaa::parse_and_verify`,
        `@${CONFIG.wormholeStateId}`,
        vectorLiteral(vaaBytes),
        `@${CONFIG.clockObjectId}`,
        "--assign",
        "verified_vaa",
        "--move-call",
        `${CONFIG.pythPackageId}::pyth::create_authenticated_price_infos_using_accumulator`,
        `@${CONFIG.pythStateId}`,
        vectorLiteral(accumulatorBytes),
        "verified_vaa",
        `@${CONFIG.clockObjectId}`,
        "--assign",
        "price_updates",
        "--split-coins",
        "gas",
        `[${CONFIG.baseUpdateFee.toString()}]`,
        "--assign",
        "fee_coin",
        "--move-call",
        `${CONFIG.pythPackageId}::pyth::update_single_price_feed`,
        `@${CONFIG.pythStateId}`,
        "price_updates",
        `@${CONFIG.priceInfoObjectId}`,
        "fee_coin.0",
        `@${CONFIG.clockObjectId}`,
        "--assign",
        "remaining_updates",
        "--move-call",
        `${CONFIG.pythPackageId}::hot_potato_vector::destroy`,
        `<${CONFIG.pythTypePrefix}::price_info::PriceInfo>`,
        "remaining_updates",
        "--serialize-unsigned-transaction",
    ];
}

function buildVerifyPtbArgs(gasCoin) {
    return [
        "client",
        "ptb",
        "--sender",
        `@${CONFIG.sender}`,
        "--gas-coin",
        `@${gasCoin}`,
        "--gas-budget",
        CONFIG.gasBudget.toString(),
        "--move-call",
        `${CONFIG.pythPackageId}::pyth::get_price_no_older_than`,
        `@${CONFIG.priceInfoObjectId}`,
        `@${CONFIG.clockObjectId}`,
        CONFIG.maxAgeSecs.toString(),
        "--serialize-unsigned-transaction",
    ];
}

function vectorLiteral(bytes) {
    return `vector[${Array.from(bytes, (value) => `0x${value.toString(16).padStart(2, "0")}`).join(", ")}]`;
}

function serializableConfig() {
    return {
        ...CONFIG,
        baseUpdateFee: CONFIG.baseUpdateFee.toString(),
        gasBudget: CONFIG.gasBudget.toString(),
        maxAgeSecs: CONFIG.maxAgeSecs.toString(),
        advanceClockSlackMs: CONFIG.advanceClockSlackMs.toString(),
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

function runJson(command, args) {
    const result = run(command, args);
    const stdout = result.stdout.trim();
    try {
        return JSON.parse(stdout);
    } catch (e) {
        throw new Error(`Failed to parse JSON output from ${command} ${args.join(" ")}: ${stdout}`);
    }
}

// Ensure `addr` owns a SUI gas coin, funding it from the donor if not. Returns
// the gas coin id. An explicit SENDER_GAS_COIN short-circuits this.
function ensureGas(addr) {
    if (CONFIG.senderGasCoin) return CONFIG.senderGasCoin;

    let coin = findGasCoin(addr);
    if (coin) return coin;

    // The sender holds no enumerable SUI on the fork. Fund it by referencing a
    // known donor coin by id (a fresh fork can't enumerate the donor's coins).
    const donorCoin = CONFIG.donorGasCoin || findGasCoin(CONFIG.suiDonor);
    if (!donorCoin) {
        throw new Error(
            `No SUI source coin. Set SENDER_GAS_COIN (a coin owned by ${addr}), ` +
                `or SUI_DONOR_GAS_COIN (a coin owned by the donor ${CONFIG.suiDonor}).`,
        );
    }
    log("step", { name: "fund", addr, fromDonor: CONFIG.suiDonor, amount: CONFIG.fundAmount });
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
    const eff = runJson(CONFIG.suiBin, [
        "client",
        "execute-signed-tx",
        "--tx-bytes",
        txBytes,
        "--json",
    ]);
    if (eff?.effects?.status?.status !== "success") {
        throw new Error(`funding tx did not succeed: ${JSON.stringify(eff?.effects?.status)}`);
    }
    for (const c of eff.effects?.created ?? []) {
        const id = c.reference?.objectId;
        const obj = id ? objectJson(id) : null;
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

function sleep(seconds) {
    spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
}

function hexToBuffer(hex) {
    const normalized = strip0x(hex);
    if (normalized.length === 0 || normalized.length % 2 !== 0) {
        throw new Error("Expected an even-length hex string");
    }
    return Buffer.from(normalized, "hex");
}

function strip0x(value) {
    return value.startsWith("0x") ? value.slice(2) : value;
}

function resolveBinary(binaryName, envVarName) {
    if (process.env[envVarName]) {
        return process.env[envVarName];
    }
    const probe = spawnSync(binaryName, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) {
        return binaryName;
    }
    throw new Error(
        `Could not locate the \`${binaryName}\` binary. Set ${envVarName} to its absolute path, ` +
            `or put it on your PATH. Note: a shell alias (e.g. \`alias ${binaryName}=…\`) will NOT work — ` +
            `child processes don't inherit shell aliases, so ${envVarName} is the reliable option.`,
    );
}

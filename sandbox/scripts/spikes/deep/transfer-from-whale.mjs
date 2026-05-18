#!/usr/bin/env node

// DBSF-001 — DEEP whale transfer spike.
//
// Validates that empty-signature impersonation on a sui-fork mainnet network
// lets us splitCoins + transferObjects from a real DEEP holder we don't have
// the private key for. Load-bearing for the production DEEP funding path
// (DBSF-007 / DBSF-008): DEEP is fixed-supply with a ProtectedTreasury, so
// the sandbox cannot mint — it has to transfer from an existing holder.
//
// Flow:
//   1. Query the donor's Coin<DEEP> objects via the `sui` CLI, pick the largest.
//   2. Build a PTB that splits TRANSFER_AMOUNT raw units off that coin and
//      transfers the chunk to RECIPIENT, with DONOR as the declared sender.
//   3. Serialize the PTB unsigned via `sui client ptb --serialize-unsigned-transaction`.
//   4. Submit via `sui client execute-signed-tx --tx-bytes ...` with no
//      signatures, which sui-fork interprets as "execute as the declared sender".

import { spawnSync } from "node:child_process";
import process from "node:process";

const CONFIG = {
    suiBin: resolveSuiBin(),
    deepCoinType:
        process.env.DEEP_COIN_TYPE ||
        "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
    donor:
        process.env.DEEP_DONOR ||
        "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d",
    recipient:
        process.env.RECIPIENT ||
        "0x0000000000000000000000000000000000000000000000000000000000000abc",
    // 1000 DEEP at 6 decimals. The "1k DEEP" amount is arbitrary; the spike
    // just needs a transfer big enough to be visible and small enough to
    // never strain a real whale balance.
    transferAmount: BigInt(process.env.TRANSFER_AMOUNT || "1000000000"),
    gasBudget: BigInt(process.env.GAS_BUDGET || "200000000"),
};

const MODES = ["build", "submit", "ptb-args", "inspect"];
const mode = process.argv[2] || "build";

if (!MODES.includes(mode)) {
    console.error(`Usage: node transfer-from-whale.mjs [${MODES.join("|")}]`);
    process.exit(2);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});

async function main() {
    const donorCoin = await findLargestDonorDeepCoin();

    if (mode === "inspect") {
        process.stdout.write(JSON.stringify({ donorCoin, config: serializableConfig() }, null, 2));
        return;
    }

    const ptbArgs = buildPtbArgs(donorCoin);

    if (mode === "ptb-args") {
        process.stdout.write(JSON.stringify(ptbArgs, null, 2));
        return;
    }

    const txBytes = run(CONFIG.suiBin, ptbArgs).stdout.trim();
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
    process.stdout.write(submit.stdout);
}

function findLargestDonorDeepCoin() {
    // This sui-fork build serves the modern gRPC API on its --rpc-addr, not the
    // legacy JSON-RPC fullnode API, so suix_getCoins is unavailable (raw POSTs
    // 404). Query the donor's coins through the `sui` CLI instead, which talks
    // gRPC to the active env — the same env the `ptb`/`execute-signed-tx` steps
    // below already rely on. Point the CLI at the fork with:
    //   sui client new-env --alias local-fork --rpc http://127.0.0.1:9000
    //   sui client switch --env local-fork
    const { stdout } = run(CONFIG.suiBin, ["client", "balance", CONFIG.donor, "--json"]);

    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw new Error(
            `Could not parse \`sui client balance ${CONFIG.donor} --json\` output: ` +
                (error instanceof Error ? error.message : String(error)),
        );
    }

    // Shape: [ [ [coinMetadataOrNull, [coinObject, ...]], ... ], totalCount ].
    // Each coinObject carries { coinType, coinObjectId, balance, ... }.
    const groups = parsed?.[0] ?? [];
    const coins = [];
    for (const group of groups) {
        for (const coin of group?.[1] ?? []) {
            // Exact match: the whale also holds DEEP under other package addresses.
            if (coin.coinType === CONFIG.deepCoinType) coins.push(coin);
        }
    }

    if (coins.length === 0) {
        throw new Error(
            `No ${CONFIG.deepCoinType} coins owned by ${CONFIG.donor} on the fork. ` +
                "Either the donor address is wrong, the DEEP coin type is wrong, " +
                "or the fork wasn't seeded with --address <donor>.",
        );
    }

    let largest = coins[0];
    for (const c of coins) {
        if (BigInt(c.balance) > BigInt(largest.balance)) largest = c;
    }

    if (BigInt(largest.balance) < CONFIG.transferAmount) {
        throw new Error(
            `Largest donor coin has balance ${largest.balance} but transfer amount is ` +
                `${CONFIG.transferAmount}. Lower TRANSFER_AMOUNT or pick a richer donor.`,
        );
    }

    return largest;
}

function buildPtbArgs(donorCoin) {
    return [
        "client",
        "ptb",
        "--sender",
        `@${CONFIG.donor}`,
        "--gas-budget",
        CONFIG.gasBudget.toString(),
        "--split-coins",
        `@${donorCoin.coinObjectId}`,
        `[${CONFIG.transferAmount.toString()}]`,
        "--assign",
        "chunk",
        "--transfer-objects",
        "[chunk.0]",
        `@${CONFIG.recipient}`,
        "--serialize-unsigned-transaction",
    ];
}

function serializableConfig() {
    return {
        ...CONFIG,
        transferAmount: CONFIG.transferAmount.toString(),
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

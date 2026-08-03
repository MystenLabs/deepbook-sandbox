// Live verification: boot devstack's dashboard() plugin alongside the DEEP and
// USDC funding plugins and assert the dashboard's Faucet surface lists both as
// editable-amount fund actions. This is the runnable proof behind "devstack's
// dashboard auto-surfaces our contributed coinType:<X> strategies" — the
// integration premise for wiring the faucet/dashboard at Phase 5.
//
// It does NOT fund anything: `fundableCoins` reads the strategy registry, so the
// contributed strategy only needs to be REGISTERED (no coin transfer, no patched
// fork required for correctness). A fork image is still needed to boot, though —
// set FORK_IMAGE_CONTEXT to the patched build context for a cached, fast boot
// (the default devstack fork image otherwise cold-builds ~12 min):
//
//   nvm use 24
//   FORK_IMAGE_CONTEXT="$PWD/../scripts/spikes/devstack-funding/.fork-patched/images" \
//   pnpm verify:dashboard-faucet
//
// Exits 0 if the dashboard surfaces DEEP and USDC as editable-amount actions, else 1.

import { Effect, Exit } from "effect";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

import { account, coin, dashboard, defineDevstack, sui } from "@mysten-incubation/devstack";

import { deepFundingFromWhale, DEEP_COIN_TYPE } from "../deep-funding.ts";
import { usdcFundingFromCapOwner, USDC_COIN_TYPE } from "../usdc-funding.ts";

const DONOR =
    process.env.DEEP_DONOR_ADDRESS ??
    "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const USDC_MINTER =
    process.env.USDC_MINTER_ADDRESS ??
    "0x41c0c6d67577b39f31a5fe4052314fd3a8b7c7f890676f60e007bd390e397ac1";
const STACK = "coin-faucet-check";

const DIST = resolve("node_modules/@mysten-incubation/devstack/dist");
const { runStack } = await import(pathToFileURL(DIST + "/api/run-stack.mjs").href);

const ctx = process.env.FORK_IMAGE_CONTEXT?.trim();
// Fork binary built from a sui rev covering current mainnet protocol (128; this
// rev is max 130); passed to the patched Dockerfile as SUI_FORK_REV. Override via SUI_FORK_REV.
const FORK_REV = process.env.SUI_FORK_REV ?? "16f1402387c7ce0f9310e57610428efec930dbf4";
const checkpoint = process.env.FORK_CHECKPOINT ? Number(process.env.FORK_CHECKPOINT) : undefined;
const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    version: FORK_REV,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(ctx ? { image: { build: { context: ctx, dockerfile: "sui-fork/Dockerfile" } } } : {}),
});
const whale = account("deepWhale", { kind: "impersonate", address: DONOR });
const deepFunding = deepFundingFromWhale({ sui: suiRef, whale });
const deepCoin = coin.known(DEEP_COIN_TYPE);
const usdcMinter = account("usdcMinter", { kind: "impersonate", address: USDC_MINTER });
const usdcFunding = usdcFundingFromCapOwner({ sui: suiRef, minter: usdcMinter });
const usdcCoin = coin.known(USDC_COIN_TYPE);
const stackDef = defineDevstack({
    members: [suiRef, whale, deepFunding, deepCoin, usdcMinter, usdcFunding, usdcCoin, dashboard()],
    stackName: STACK,
});

const handle = runStack(stackDef, {
    identity: { stack: STACK },
    appRoot: resolve("."),
    runtimeRoot: ".devstack",
});

const FUNDABLE_QUERY = "{ fundableCoins { symbol coinType honorsAmount requiresAccountSigner } }";

/** The dashboard server listens IN THIS PROCESS; the routed *.localhost URL is
 *  not reachable from the host, so query the in-process loopback listeners and
 *  return the first that answers the fundableCoins query. */
async function fetchFundableCoins() {
    const ports = [
        ...new Set(
            execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${process.pid} 2>/dev/null || true`)
                .toString()
                .split("\n")
                .map((l) => l.match(/:(\d+)\s*\(LISTEN\)/)?.[1])
                .filter(Boolean),
        ),
    ];
    for (const port of ports) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: FUNDABLE_QUERY }),
            });
            if (!res.ok) continue;
            const json = await res.json();
            if (Array.isArray(json?.data?.fundableCoins)) return json.data.fundableCoins;
        } catch {
            /* not the dashboard port — try the next */
        }
    }
    throw new Error(
        `no in-process dashboard /graphql responded (tried ports: ${ports.join(", ")})`,
    );
}

let failed = false;
console.error("booting fork + DEEP/USDC plugins + dashboard()...");
const exit = await Effect.runPromiseExit(handle.start);
if (Exit.isFailure(exit)) {
    console.error("BOOT FAILED:", inspect(exit.cause, { depth: 12 }));
    process.exit(1);
}

try {
    const coins = await fetchFundableCoins();
    console.error("dashboard fundableCoins:", inspect(coins, { depth: 4 }));
    for (const { symbol, coinType } of [
        { symbol: "DEEP", coinType: DEEP_COIN_TYPE },
        { symbol: "USDC", coinType: USDC_COIN_TYPE },
    ]) {
        const entry = coins.find((c) => c.coinType === coinType);
        if (entry === undefined) {
            console.error(`\n✗ ${symbol} (${coinType}) is NOT in the dashboard's fundable coins`);
            failed = true;
        } else if (entry.honorsAmount !== true) {
            console.error(
                `\n✗ ${symbol} is listed but not editable-amount (honorsAmount=${entry.honorsAmount})`,
            );
            failed = true;
        } else {
            console.error(
                `\n✓ devstack's dashboard surfaces ${symbol} as an editable-amount fund action`,
            );
        }
    }
} catch (e) {
    console.error("\n✗ verification error:", e?.message ?? e);
    failed = true;
} finally {
    console.error("tearing down...");
    await Effect.runPromise(handle.stop).catch(() => {});
    await Effect.runPromise(handle.awaitShutdown).catch(() => {});
}

process.exit(failed ? 1 : 0);

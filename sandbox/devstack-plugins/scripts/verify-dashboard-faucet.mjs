// Live verification: boot devstack's dashboard() plugin alongside the DEEP
// funding plugin and assert the dashboard's Faucet surface lists DEEP as an
// editable-amount fund action. This is the runnable proof behind "devstack's
// dashboard auto-surfaces our contributed coinType:<DEEP> strategy" — the
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
// Exits 0 if the dashboard surfaces DEEP as an editable-amount action, else 1.

import { Effect, Exit } from "effect";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

import { account, coin, dashboard, defineDevstack, sui } from "@mysten-incubation/devstack";

import { deepFundingFromWhale, DEEP_COIN_TYPE } from "../deep-funding.ts";

const DONOR = "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const STACK = "deep-faucet-check";

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
const stackDef = defineDevstack({
    members: [suiRef, whale, deepFunding, deepCoin, dashboard()],
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
console.error("booting fork + DEEP plugin + dashboard()...");
const exit = await Effect.runPromiseExit(handle.start);
if (Exit.isFailure(exit)) {
    console.error("BOOT FAILED:", inspect(exit.cause, { depth: 12 }));
    process.exit(1);
}

try {
    const coins = await fetchFundableCoins();
    console.error("dashboard fundableCoins:", inspect(coins, { depth: 4 }));
    const deep = coins.find((c) => c.coinType === DEEP_COIN_TYPE);
    if (deep === undefined) {
        console.error(`\n✗ DEEP (${DEEP_COIN_TYPE}) is NOT in the dashboard's fundable coins`);
        failed = true;
    } else if (deep.honorsAmount !== true) {
        console.error(
            `\n✗ DEEP is listed but not editable-amount (honorsAmount=${deep.honorsAmount})`,
        );
        failed = true;
    } else {
        console.error("\n✓ devstack's dashboard surfaces DEEP as an editable-amount fund action");
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

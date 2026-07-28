// Boot a devstack stack with the DEEP funding plugin + devstack's dashboard()
// and STAY UP so you can open the dashboard in a browser. The Faucet panel shows
// DEEP (editable amount) + SUI; alice is pre-funded with DEEP.
//
//   nvm use 24
//   FORK_IMAGE_CONTEXT="$PWD/../scripts/spikes/devstack-funding/.fork-patched/images" \
//   pnpm dashboard:up
//
// Or, with a prebuilt patched image (skips the source build):
//   DEVSTACK_SUI_FORK_IMAGE=<registry-ref> pnpm dashboard:up
//
// Then open the printed http://127.0.0.1:<port>/ URL. Ctrl+C to stop.
// Needs Docker + Node >= 24 + the patched fork image (alice's DEEP funding runs
// at boot, which a stock fork aborts; see deep-funding.ts).

import { Effect, Exit } from "effect";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

import { account, coin, dashboard, defineDevstack, sui } from "@mysten-incubation/devstack";

import { deepFundingFromWhale, DEEP_COIN_TYPE } from "../deep-funding.ts";
import { ALICE_KEYPAIR } from "../__tests__/alice.ts";

const DONOR = "0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d";
const STACK = process.env.DASHBOARD_STACK ?? "deep-dashboard";

const DIST = resolve("node_modules/@mysten-incubation/devstack/dist");
const { runStack } = await import(pathToFileURL(DIST + "/api/run-stack.mjs").href);

const ctx = process.env.FORK_IMAGE_CONTEXT?.trim();
// Prebuilt patched image ref (skips the source build entirely; wins over
// FORK_IMAGE_CONTEXT). devstack ignores this env var when an explicit
// `image.build` is passed, so we resolve the precedence ourselves.
const pulled = process.env.DEVSTACK_SUI_FORK_IMAGE?.trim();
// Build the fork binary from a sui rev whose protocol config covers current
// mainnet (protocol 128; this rev is max 130). `version` is passed to the patched
// Dockerfile as SUI_FORK_REV (see devstack sui/mode/fork.mjs). Override via SUI_FORK_REV.
const FORK_REV = process.env.SUI_FORK_REV ?? "16f1402387c7ce0f9310e57610428efec930dbf4";
// Checkpoint pin no longer required (the binary supports current mainnet); kept
// optional via FORK_CHECKPOINT for reproducibility / pre-upgrade state.
const checkpoint = process.env.FORK_CHECKPOINT ? Number(process.env.FORK_CHECKPOINT) : undefined;
// Precedence: prebuilt pull > patched build context > devstack default build.
let imageOpt = {};
if (pulled) imageOpt = { image: { pull: pulled } };
else if (ctx) imageOpt = { image: { build: { context: ctx, dockerfile: "sui-fork/Dockerfile" } } };

const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    version: FORK_REV,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...imageOpt,
});
const whale = account("deepWhale", { kind: "impersonate", address: DONOR });
const deepFunding = deepFundingFromWhale({ sui: suiRef, whale });
const deepCoin = coin.known(DEEP_COIN_TYPE);
const alice = account("alice", {
    kind: "signer",
    signer: ALICE_KEYPAIR,
    funding: [{ coin: deepCoin, amount: 1000n, via: deepFunding }],
});
const stackDef = defineDevstack({
    members: [suiRef, whale, deepFunding, deepCoin, alice, dashboard()],
    stackName: STACK,
});

const handle = runStack(stackDef, {
    identity: { stack: STACK },
    appRoot: resolve("."),
    runtimeRoot: ".devstack",
});

let imageNote = " (default image — may cold-build ~12 min)";
if (pulled) imageNote = ` (prebuilt image ${pulled})`;
else if (ctx) imageNote = " (patched image)";
console.error(`booting fork + DEEP plugin + dashboard()${imageNote}...`);
const exit = await Effect.runPromiseExit(handle.start);
if (Exit.isFailure(exit)) {
    console.error("BOOT FAILED:", inspect(exit.cause, { depth: 12 }));
    process.exit(1);
}

/** The dashboard SPA + GraphQL listen IN THIS PROCESS on a loopback port. Find
 *  the listener that answers GraphQL and return its browser URL. */
async function dashboardUrl() {
    const ports = [
        ...new Set(
            execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${process.pid} 2>/dev/null || true`)
                .toString()
                .split("\n")
                .map((l) => l.match(/:(\d+)\s*\(LISTEN\)/)?.[1])
                .filter(Boolean),
        ),
    ];
    for (const p of ports) {
        try {
            const r = await fetch(`http://127.0.0.1:${p}/graphql`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: "{ ping }" }),
            });
            if (r.ok && (await r.json())?.data?.ping) return `http://127.0.0.1:${p}/`;
        } catch {
            /* not the dashboard */
        }
    }
    return null;
}

const url = await dashboardUrl();
const bar = "=".repeat(64);
console.error(`\n${bar}`);
console.error("  devstack dashboard is UP — open in your browser:");
console.error(`    ${url ?? "(port not detected — check `lsof -p <pid>` for the LISTEN port)"}`);
console.error("  Faucet panel: DEEP (editable amount) + SUI; alice pre-funded.");
console.error("  Press Ctrl+C to stop.");
console.error(`${bar}\n`);

const stop = async () => {
    console.error("\nstopping...");
    await Effect.runPromise(handle.stop).catch(() => {});
    await Effect.runPromise(handle.awaitShutdown).catch(() => {});
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Effect.runPromise(handle.awaitShutdown);

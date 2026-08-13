// sandbox/devstack-plugins/scripts/stack-smoke.mjs
// Boot the PRODUCTION stack (../devstack.config.ts) once, assert every member
// row settles (ready for services, done for task-role plugins) and the boot
// stayed inside SMOKE_TIMEOUT_MS (default 3 min — the DBSF-021 AC on WARM
// images; a first-ever run may compile the fork image AND the fork indexer
// image (SEDEFI-445 — a full Rust release build) and blow the budget: run
// `pnpm deploy-all` once first, or set DEVSTACK_SUI_FORK_IMAGE /
// INDEXER_IMAGE). Always tears down. Exit 0 = green.
//
//   nvm use 24
//   pnpm smoke

import { Effect, Exit, SubscriptionRef } from "effect";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import stackDef, { STACK } from "../devstack.config.ts";

const DIST = resolve("node_modules/@mysten-incubation/devstack/dist");
const { runStack } = await import(pathToFileURL(DIST + "/api/run-stack.mjs").href);

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

const handle = runStack(stackDef, {
    identity: { stack: STACK },
    appRoot: resolve("."),
    runtimeRoot: ".devstack",
});

console.error(`smoke: booting stack "${STACK}" (budget ${TIMEOUT_MS}ms)...`);
const SETTLED = new Set(["ready", "done"]);
let failed = false;
let bootMs = 0;
try {
    const started = Date.now();
    const exit = await Effect.runPromiseExit(handle.start);
    bootMs = Date.now() - started;

    if (Exit.isFailure(exit)) {
        // `start` forks the supervisor via a DETACHED fiber (see
        // run-stack-internal.mjs) — on boot failure the fiber (and every
        // container it already acquired) stays alive until `stop` +
        // `awaitShutdown` run. Fall through to the `finally` instead of
        // exiting here, or a failed boot leaks every container it started.
        console.error("✗ smoke BOOT FAILED:", inspect(exit.cause, { depth: 12 }));
        failed = true;
    } else {
        const state = await Effect.runPromise(SubscriptionRef.get(handle.state));
        if (state.rows.length === 0) {
            console.error("  ✗ no member rows in the supervisor projection");
            failed = true;
        }
        for (const row of state.rows) {
            const ok = SETTLED.has(row.status);
            console.error(`  ${ok ? "✓" : "✗"} ${row.key}: ${row.status}`);
            if (!ok) failed = true;
        }
        if (bootMs > TIMEOUT_MS) {
            console.error(`  ✗ boot took ${bootMs}ms > budget ${TIMEOUT_MS}ms`);
            failed = true;
        }
    }
} catch (e) {
    console.error("✗ smoke error:", e?.message ?? e);
    failed = true;
} finally {
    console.error("smoke: tearing down...");
    await Effect.runPromise(handle.stop).catch(() => {});
    await Effect.runPromise(handle.awaitShutdown).catch(() => {});
}

console.error(failed ? `✗ smoke FAILED (boot ${bootMs}ms)` : `✓ smoke OK (boot ${bootMs}ms)`);
process.exit(failed ? 1 : 0);

// Live verification (DBSF-017): boot devstack's FIRST-PARTY deepbook() member
// in mode 'known' — plus knownPackage members for deepbook, margin, and
// liquidation — against a mainnet fork, pinned to the DBSF-016 ids
// (deployments/mainnet-fork.json).
//
// What's chain-proven vs. carried: each knownPackage chain-probes its pinned
// PACKAGE id ON THE FORK (the deepbook probe exists here for exactly that —
// known mode's own start does no chain I/O). The registry/margin-registry
// object ids ride in from the manifest, whose pins are drift-checked against
// mainnet by `pnpm verify:deepbook-ids`. The script additionally asserts the
// supervisor projection carries the expected member rows and known-package ids.
//
// A STOCK fork image suffices — no funding members, no non-SUI coin execution.
// Set FORK_IMAGE_CONTEXT / SUI_FORK_REV / FORK_CHECKPOINT as with the other
// verify scripts (see verify-dashboard-faucet.mjs).
//
//   nvm use 24
//   pnpm verify:deepbook-member
//
// Exits 0 if the stack boots and the projection checks pass, else 1.

import { Effect, Exit, SubscriptionRef } from "effect";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineDevstack, knownPackage, sui } from "@mysten-incubation/devstack";

import {
    deepbookFromManifest,
    deepbookMarginPackagesFromManifest,
    mainnetForkDeepbookIds,
} from "../deepbook-known.ts";
import { resolveForkCheckpoint } from "../fork-checkpoint.ts";

const STACK = "deepbook-known-check";

const DIST = resolve("node_modules/@mysten-incubation/devstack/dist");
const { runStack } = await import(pathToFileURL(DIST + "/api/run-stack.mjs").href);

const ctx = process.env.FORK_IMAGE_CONTEXT?.trim();
const FORK_REV = process.env.SUI_FORK_REV ?? "16f1402387c7ce0f9310e57610428efec930dbf4";
const checkpoint = resolveForkCheckpoint(process.env.FORK_CHECKPOINT);
const suiRef = sui({
    mode: "fork",
    upstream: "mainnet",
    version: FORK_REV,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(ctx ? { image: { build: { context: ctx, dockerfile: "sui-fork/Dockerfile" } } } : {}),
});

const ids = mainnetForkDeepbookIds();
const deepbookMember = deepbookFromManifest();
const { margin, liquidation } = deepbookMarginPackagesFromManifest();
// Chain-proves the deepbook PACKAGE pin (the known-mode member itself does no
// chain I/O at start) — verify-script-only, not part of the composed module.
const deepbookPackageProbe = knownPackage("deepbook-core", {
    packageId: ids.packages.deepbook.latestId,
});
const stackDef = defineDevstack({
    members: [suiRef, deepbookMember, deepbookPackageProbe, margin, liquidation],
    stackName: STACK,
});

const handle = runStack(stackDef, {
    identity: { stack: STACK },
    appRoot: resolve("."),
    runtimeRoot: ".devstack",
});

let failed = false;
const check = (label, cond, detail) => {
    console.error(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failed = true;
};

console.error("booting fork + deepbook(known) + margin/liquidation knownPackages...");
const exit = await Effect.runPromiseExit(handle.start);
if (Exit.isFailure(exit)) {
    console.error("BOOT FAILED:", inspect(exit.cause, { depth: 12 }));
    process.exit(1);
}

// Task-role plugins (deepbook known, knownPackage) finish in terminal `done`;
// long-running services sit at `ready`. Both are boot success.
const SETTLED = new Set(["ready", "done"]);

try {
    const state = await Effect.runPromise(SubscriptionRef.get(handle.state));

    const deepbookRow = state.rows.find((r) => String(r.key).startsWith("deepbook"));
    check(
        "deepbook(known) member booted (ready/done)",
        deepbookRow !== undefined && SETTLED.has(deepbookRow.status),
        deepbookRow ? `${deepbookRow.key}: ${deepbookRow.status}` : "row missing",
    );

    for (const [label, name, pin] of [
        ["deepbook package", "deepbook-core", ids.packages.deepbook],
        ["margin", "deepbook-margin", ids.packages.deepbookMargin],
        ["liquidation", "margin-liquidation", ids.packages.marginLiquidation],
    ]) {
        const pkg = state.packages.find((p) => p.name === name);
        check(
            `${label} knownPackage probed on the fork with the pinned id`,
            pkg?.kind === "known" && pkg?.packageId === pin.latestId,
            pkg ? `${pkg.packageId} (${pkg.kind})` : "projection missing",
        );
        const row = pkg?.rowKey ? state.rows.find((r) => r.key === pkg.rowKey) : undefined;
        check(
            `${label} knownPackage row settled (ready/done)`,
            row !== undefined && SETTLED.has(row.status),
            row?.status,
        );
    }
} catch (e) {
    console.error("\n✗ verification error:", e?.message ?? e);
    failed = true;
} finally {
    console.error("tearing down...");
    await Effect.runPromise(handle.stop).catch(() => {});
    await Effect.runPromise(handle.awaitShutdown).catch(() => {});
}

console.error(
    failed
        ? "\n✗ deepbook known-mode verification FAILED"
        : "\n✓ devstack's deepbook() known member + margin/liquidation pins verified on the fork",
);
process.exit(failed ? 1 : 0);

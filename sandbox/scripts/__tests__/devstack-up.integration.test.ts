// sandbox/scripts/__tests__/devstack-up.integration.test.ts
// Smoke (DBSF-021 AC): the production devstack stack reaches ready in < 3 min
// on a warm fork image. Spawns devstack-plugins/scripts/stack-smoke.mjs, which
// boots via runStack, asserts every member row settles, and tears down.
// Requires Docker + Node >= 24 (devstack floor); skips loudly otherwise.

import { execFileSync, execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const PLUGINS_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "devstack-plugins",
);

function dockerAvailable(): boolean {
    try {
        execSync("docker info", { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const skip = process.env.SKIP_DEVSTACK_SMOKE === "1" || !dockerAvailable() || nodeMajor < 24;
if (skip) {
    console.warn(
        `devstack-up smoke SKIPPED (SKIP_DEVSTACK_SMOKE=${process.env.SKIP_DEVSTACK_SMOKE ?? ""}, ` +
            `docker=${dockerAvailable()}, node=${process.versions.node} — needs >= 24)`,
    );
}

describe("devstack-up smoke", () => {
    it.skipIf(skip)("boots the production stack to settled within the smoke budget", () => {
        // Pre-warm devstack-plugins dependencies to avoid ERR_MODULE_NOT_FOUND
        // on fresh clone (stack-smoke.mjs imports effect + devstack by bare specifier).
        // --ignore-scripts suppresses pnpm 11's build-script warnings; --frozen-lockfile
        // prevents accidental lockfile rewrites during test runs.
        execFileSync(
            "pnpm",
            ["install", "--ignore-workspace", "--ignore-scripts", "--frozen-lockfile"],
            {
                cwd: PLUGINS_DIR,
                stdio: "inherit",
                timeout: 120_000, // fresh-clone install headroom; fast no-op when warm
            },
        );
        execFileSync("node", ["scripts/stack-smoke.mjs"], {
            cwd: PLUGINS_DIR,
            stdio: "inherit",
            timeout: 480_000, // stack boot budget; account for pnpm install above (vitest testTimeout 600s)
        });
    });
});

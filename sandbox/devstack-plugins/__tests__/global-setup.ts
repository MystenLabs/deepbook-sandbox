// Vitest globalSetup for the e2e run: boots the fork fixture stack once before
// the suite and tears it down after (the returned teardown). Referenced by
// vitest.e2e.config.ts via `test.globalSetup`.
//
// We use a custom module (rather than `autoBoot: true`) because the fixture
// config lives in this subdir — `configPath` points the harness at it instead of
// the default walk-up from cwd.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { devstackVitestGlobalSetup } from "@mysten-incubation/devstack/vitest";

import { STACK_NAME } from "./stack.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export default devstackVitestGlobalSetup({
    configPath: join(HERE, "devstack.config.ts"),
    stack: STACK_NAME,
    // The FIRST run compiles sui-fork from source (~12 min); cached after. Allow
    // for that so a cold machine/CI doesn't time out mid-build.
    bootTimeoutMs: 1_500_000, // 25 min (cold sui-fork compile of a fresh rev)
});

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
    bootTimeoutMs: 540_000, // cold fork boot under image build/pull
});

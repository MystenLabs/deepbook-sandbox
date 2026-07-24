import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    devstackVitestServerConfig,
    devstackVitestTestConfig,
} from "@mysten-incubation/devstack/vitest";
import { defineConfig } from "vitest/config";

import { STACK_NAME } from "./__tests__/stack.ts";

// E2E config: boots the fork fixture stack (global-setup.ts) and runs only the
// *.e2e.test.ts files against it. Opt-in (`pnpm test:e2e`) — the unit `pnpm test`
// excludes these. Needs Docker + the patched fork image (FORK_IMAGE_CONTEXT).
const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    server: devstackVitestServerConfig(),
    test: devstackVitestTestConfig({
        // Our setup file wires beforeAll to capture the booted stack's manifest for
        // getStackContext() (the bare devstack setup module exports the hooks but
        // doesn't wire them — see __tests__/e2e-setup.ts).
        setupFile: join(HERE, "__tests__", "e2e-setup.ts"),
        threads: "single", // one shared devstack ⇒ no parallel suites
        test: {
            include: ["__tests__/**/*.e2e.test.ts"],
            globalSetup: [join(HERE, "__tests__", "global-setup.ts")],
            env: { DEVSTACK_STACK: STACK_NAME },
            testTimeout: 600_000,
            hookTimeout: 1_500_000, // first run compiles sui-fork from a fresh rev (~20 min)
        },
    }),
});

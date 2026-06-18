// Vitest setupFile for the e2e run: wires devstack's beforeAll/afterAll so the
// booted stack's manifest is captured and readable via getStackContext() inside
// the test. The bare `@mysten-incubation/devstack/vitest/setup` module only
// EXPORTS the hooks (no top-level wiring), so a user setup file must call
// useDevstackTestSetup itself. We pass the stack name explicitly (the worker
// resolves the manifest by stack, independent of the globalSetup process env).

import { afterAll, beforeAll } from "vitest";

import { useDevstackTestSetup } from "@mysten-incubation/devstack/vitest";

import { STACK_NAME } from "./stack.ts";

useDevstackTestSetup(
    { beforeAll, afterAll },
    { stack: STACK_NAME, requireDevstack: true, silent: true },
);

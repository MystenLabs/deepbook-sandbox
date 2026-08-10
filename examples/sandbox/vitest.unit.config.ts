import { defineConfig } from "vitest/config";

// Mirrors sandbox/vitest.unit.config.ts so both subprojects behave the same.
// These tests never touch a chain, a container, or the network — they run the
// order-book helpers against a stubbed client, so they stay in milliseconds.
export default defineConfig({
    test: {
        include: ["__tests__/**/*.unit.test.ts"],
        pool: "threads",
        testTimeout: 10_000,
        hookTimeout: 5_000,
    },
});

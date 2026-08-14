import { defineConfig } from "vitest/config";

// Mirrors sandbox/vitest.unit.config.ts so both subprojects behave the same.
// These tests never touch a chain, a container, or the network — they run the
// order-book helpers against a stubbed client, so they stay in milliseconds.
export default defineConfig({
    test: {
        // Deliberately broader than sandbox/'s pattern. There are no integration
        // tests here, so the `.unit.` infix buys nothing and only creates a way to
        // add a test file that never runs while still typechecking green. The
        // leading `**/` catches a __tests__ directory nested under a subfolder.
        include: ["**/__tests__/**/*.test.ts"],
        pool: "threads",
        testTimeout: 10_000,
        hookTimeout: 5_000,
    },
});

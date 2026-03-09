import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/__tests__/**/*.unit.test.ts"],
        testTimeout: 30_000, // 30s per unit test
        hookTimeout: 10_000, // 10s for setup/teardown
    },
});

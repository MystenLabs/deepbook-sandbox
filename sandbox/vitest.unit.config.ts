import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/__tests__/**/*.unit.test.ts"],
        pool: "threads",
        testTimeout: 10_000,
        hookTimeout: 5_000,
    },
});

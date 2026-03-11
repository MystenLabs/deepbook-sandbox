import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["scripts/__tests__/**/*.test.ts"],
        pool: "forks",
        poolOptions: { forks: { singleFork: true } },
        testTimeout: 600_000, // 10 min per test (deploy is ~5 min)
        hookTimeout: 300_000, // 5 min for beforeAll/afterAll
    },
});

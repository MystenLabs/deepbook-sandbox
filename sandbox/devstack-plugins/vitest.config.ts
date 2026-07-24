import { configDefaults, defineConfig } from "vitest/config";

// Unit config — roots here (this package is nested under sandbox/, whose own
// vitest config we must not inherit). Runs the stubbed-fork unit tests and
// EXCLUDES the *.e2e.test.ts files (those boot Docker; run them via the e2e
// config — `pnpm test:e2e`).
export default defineConfig({
    test: {
        include: ["__tests__/**/*.test.ts"],
        exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
    },
});

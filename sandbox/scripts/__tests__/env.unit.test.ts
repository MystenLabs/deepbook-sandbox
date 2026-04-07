import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import { cleanEnvFile, REQUIRED_ENV_KEYS, USER_ENV_KEYS, validateEnvFile } from "../utils/env";
import log from "../utils/logger";

describe("env utility tests", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), "env-test-"));
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true });
    });

    async function writeEnv(content: string): Promise<void> {
        await writeFile(path.join(tmpDir, ".env"), content, "utf-8");
    }

    async function readEnv(): Promise<string> {
        return readFile(path.join(tmpDir, ".env"), "utf-8");
    }

    /** Helper: builds .env content with all required keys populated. */
    function requiredBlock(): string {
        return "PRIVATE_KEY=0xabc123\nSUI_TOOLS_IMAGE=mysten/sui-tools:compat\n";
    }

    describe("cleanEnvFile", () => {
        it("preserves allowlisted keys and removes non-allowlisted keys", async () => {
            await writeEnv(requiredBlock() + "KEEP_ME=hello\nREMOVE_ME=bye\nALSO_KEEP=world\n");

            cleanEnvFile(tmpDir, new Set([...REQUIRED_ENV_KEYS, "KEEP_ME", "ALSO_KEEP"]));

            const result = await readEnv();
            expect(result).toContain("KEEP_ME=hello");
            expect(result).toContain("ALSO_KEEP=world");
            expect(result).not.toContain("REMOVE_ME");
        });

        it("keeps comments and blank lines", async () => {
            await writeEnv(
                "# This is a comment\n\n" + requiredBlock() + "DROP=no\n# Another comment\n",
            );

            cleanEnvFile(tmpDir, new Set([...REQUIRED_ENV_KEYS]));

            const result = await readEnv();
            expect(result).toContain("# This is a comment");
            expect(result).toContain("# Another comment");
            expect(result).not.toContain("DROP=no");
            // Blank lines preserved
            expect(result).toMatch(/\n\n/);
        });

        it("no-op when .env file is missing (no throw)", () => {
            expect(() => {
                cleanEnvFile(tmpDir, new Set(["ANYTHING"]));
            }).not.toThrow();
        });

        it("handles values with special characters (= in URLs, spaces, quotes)", async () => {
            const lines = [
                "PRIVATE_KEY=suiprivkey1abc123==",
                "SUI_TOOLS_IMAGE=mysten/sui-tools:compat",
                "DB_URL=postgres://user:pass@host:5432/db?sslmode=require",
                'QUOTED="hello world"',
                "SPACED=some value with spaces",
            ].join("\n");
            await writeEnv(lines);

            cleanEnvFile(tmpDir, new Set([...REQUIRED_ENV_KEYS, "DB_URL", "QUOTED", "SPACED"]));

            const result = await readEnv();
            expect(result).toContain("DB_URL=postgres://user:pass@host:5432/db?sslmode=require");
            expect(result).toContain('QUOTED="hello world"');
            expect(result).toContain("SPACED=some value with spaces");
        });

        it("handles empty allowlist (removes all key=value lines, warns about required keys)", async () => {
            await writeEnv("# header\nFOO=bar\nBAZ=qux\n");

            const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
            try {
                cleanEnvFile(tmpDir, new Set());

                const result = await readEnv();
                expect(result).toContain("# header");
                expect(result).not.toContain("FOO=bar");
                expect(result).not.toContain("BAZ=qux");

                // Should warn about missing required keys
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PRIVATE_KEY"));
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("handles file with only comments and blank lines", async () => {
            const content = "# just comments\n\n# and blanks\n";
            await writeEnv(content);

            const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
            try {
                cleanEnvFile(tmpDir, new Set(["ANYTHING"]));

                const result = await readEnv();
                expect(result).toContain("# just comments");
                expect(result).toContain("# and blanks");
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("warns on preserved keys with empty values", async () => {
            await writeEnv(requiredBlock() + "EMPTY_KEY=\nGOOD_KEY=value\n");

            const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
            try {
                cleanEnvFile(tmpDir, new Set([...REQUIRED_ENV_KEYS, "EMPTY_KEY", "GOOD_KEY"]));

                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("EMPTY_KEY"));
            } finally {
                warnSpy.mockRestore();
            }

            // File is still written (non-throwing)
            const result = await readEnv();
            expect(result).toContain("EMPTY_KEY=");
            expect(result).toContain("GOOD_KEY=value");
        });

        it("warns when required keys (PRIVATE_KEY, SUI_TOOLS_IMAGE) are missing", async () => {
            // .env has none of the required keys
            await writeEnv("SOME_OTHER_KEY=value\n");

            const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
            try {
                cleanEnvFile(tmpDir, new Set(["SOME_OTHER_KEY"]));

                expect(warnSpy).toHaveBeenCalledTimes(1);
                const warnMsg = warnSpy.mock.calls[0][0];
                expect(warnMsg).toContain("PRIVATE_KEY");
                expect(warnMsg).toContain("SUI_TOOLS_IMAGE");
            } finally {
                warnSpy.mockRestore();
            }

            // File is still written (non-throwing)
            const result = await readEnv();
            expect(result).toContain("SOME_OTHER_KEY=value");
        });

        it("does not warn when all required keys are present with values", async () => {
            await writeEnv(requiredBlock());

            const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
            try {
                cleanEnvFile(tmpDir, new Set([...REQUIRED_ENV_KEYS]));

                expect(warnSpy).not.toHaveBeenCalled();
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    describe("validateEnvFile", () => {
        it("returns valid when all required keys present with values", async () => {
            await writeEnv(requiredBlock());

            const result = validateEnvFile(tmpDir);
            expect(result.valid).toBe(true);
            expect(result.fileExists).toBe(true);
            expect(result.present).toEqual(expect.arrayContaining([...REQUIRED_ENV_KEYS]));
            expect(result.missing).toEqual([]);
        });

        it("returns invalid with missing keys listed", async () => {
            await writeEnv("PRIVATE_KEY=0xabc\n");

            const result = validateEnvFile(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.fileExists).toBe(true);
            expect(result.present).toEqual(["PRIVATE_KEY"]);
            expect(result.missing).toEqual(expect.arrayContaining(["SUI_TOOLS_IMAGE"]));
        });

        it("returns invalid when required keys have empty values", async () => {
            await writeEnv("PRIVATE_KEY=0xabc\nSUI_TOOLS_IMAGE=  \n");

            const result = validateEnvFile(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.fileExists).toBe(true);
            expect(result.present).toEqual(["PRIVATE_KEY"]);
            expect(result.missing).toEqual(expect.arrayContaining(["SUI_TOOLS_IMAGE"]));
        });

        it("returns fileExists=false and all missing when .env does not exist", () => {
            const result = validateEnvFile(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.fileExists).toBe(false);
            expect(result.present).toEqual([]);
            expect(result.missing).toEqual([...REQUIRED_ENV_KEYS]);
        });
    });

    describe("down.ts cleanup (cleanEnvFile + USER_ENV_KEYS)", () => {
        it("preserves user-configured keys and removes auto-generated keys", async () => {
            const content = [
                "# DeepBook sandbox env",
                "",
                "# User keys",
                "PRIVATE_KEY=suiprivkey1abc",
                "SUI_TOOLS_IMAGE=mysten/sui-tools:compat",
                "MM_SPREAD_BPS=10",
                "MM_LEVELS_PER_SIDE=5",
                "RUST_LOG=info",
                "",
                "# Auto-generated by deploy-all",
                "DEEPBOOK_PACKAGE_ID=0xdeadbeef",
                "POOL_ID=0xcafe",
                "MARKET_MAKER_KEY=suiprivkey1mm",
                "ORACLE_PRIVATE_KEY=suiprivkey1oracle",
                'MM_POOLS=[{"poolId":"0xcafe"}]',
                "DEEP_COIN_TYPE=0x1::deep::DEEP",
                "SUI_COIN_TYPE=0x2::sui::SUI",
                "BALANCE_MANAGER_ID=0xbm",
                "PYTH_PACKAGE_ID=0xpyth",
                "DEEP_PRICE_INFO_OBJECT_ID=0xdpi",
                "SUI_PRICE_INFO_OBJECT_ID=0xspi",
            ].join("\n");
            await writeEnv(content);

            cleanEnvFile(tmpDir, USER_ENV_KEYS);

            const result = await readEnv();

            // User keys preserved
            expect(result).toContain("PRIVATE_KEY=suiprivkey1abc");
            expect(result).toContain("SUI_TOOLS_IMAGE=mysten/sui-tools:compat");
            expect(result).toContain("MM_SPREAD_BPS=10");
            expect(result).toContain("MM_LEVELS_PER_SIDE=5");
            expect(result).toContain("RUST_LOG=info");

            // Comments preserved
            expect(result).toContain("# DeepBook sandbox env");
            expect(result).toContain("# User keys");
            expect(result).toContain("# Auto-generated by deploy-all");

            // Auto-generated keys removed
            expect(result).not.toContain("DEEPBOOK_PACKAGE_ID");
            expect(result).not.toContain("POOL_ID");
            expect(result).not.toContain("MARKET_MAKER_KEY");
            expect(result).not.toContain("ORACLE_PRIVATE_KEY");
            expect(result).not.toContain("MM_POOLS");
            expect(result).not.toContain("DEEP_COIN_TYPE");
            expect(result).not.toContain("SUI_COIN_TYPE");
            expect(result).not.toContain("BALANCE_MANAGER_ID");
            expect(result).not.toContain("PYTH_PACKAGE_ID");
            expect(result).not.toContain("DEEP_PRICE_INFO_OBJECT_ID");
            expect(result).not.toContain("SUI_PRICE_INFO_OBJECT_ID");
        });

        it("handles .env with only auto-generated keys (all removed, warns about required)", async () => {
            const content = [
                "DEEPBOOK_PACKAGE_ID=0xdeadbeef",
                "POOL_ID=0xcafe",
                'MM_POOLS=[{"poolId":"0xcafe"}]',
            ].join("\n");
            await writeEnv(content);

            const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
            try {
                cleanEnvFile(tmpDir, USER_ENV_KEYS);

                // All keys removed
                const result = await readEnv();
                expect(result).not.toContain("DEEPBOOK_PACKAGE_ID");
                expect(result).not.toContain("POOL_ID");
                expect(result).not.toContain("MM_POOLS");

                // Warns about missing required keys
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PRIVATE_KEY"));
            } finally {
                warnSpy.mockRestore();
            }
        });
    });
});

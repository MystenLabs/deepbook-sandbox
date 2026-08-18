import { describe, expect, it } from "vitest";

import { DEFAULT_FORK_CHECKPOINT, resolveForkCheckpoint } from "../fork-checkpoint.ts";

describe("resolveForkCheckpoint", () => {
    it("defaults to the pin when unset or empty", () => {
        expect(resolveForkCheckpoint(undefined)).toBe(DEFAULT_FORK_CHECKPOINT);
        expect(resolveForkCheckpoint("")).toBe(DEFAULT_FORK_CHECKPOINT);
        expect(resolveForkCheckpoint("  ")).toBe(DEFAULT_FORK_CHECKPOINT);
    });

    it("unpins on the latest sentinel (trimmed)", () => {
        expect(resolveForkCheckpoint("latest")).toBeUndefined();
        expect(resolveForkCheckpoint(" latest ")).toBeUndefined();
    });

    it("parses explicit numeric pins", () => {
        expect(resolveForkCheckpoint("304941000")).toBe(304941000);
        expect(resolveForkCheckpoint(" 123456 ")).toBe(123456);
    });

    it("rejects garbage instead of producing --checkpoint NaN", () => {
        expect(() => resolveForkCheckpoint("LATEST")).toThrow(/FORK_CHECKPOINT/);
        expect(() => resolveForkCheckpoint("3o4941000")).toThrow(/FORK_CHECKPOINT/);
        expect(() => resolveForkCheckpoint("-5")).toThrow(/FORK_CHECKPOINT/);
        expect(() => resolveForkCheckpoint("1.5")).toThrow(/FORK_CHECKPOINT/);
    });
});

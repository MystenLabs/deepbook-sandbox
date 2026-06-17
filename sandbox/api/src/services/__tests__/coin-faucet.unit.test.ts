import { describe, test, expect } from "vitest";
import { isExhaustedError, stringifyExecutionError, classifyFailure } from "../coin-faucet.js";

describe("isExhaustedError", () => {
    test("matches the SDK build-time insufficient-balance throw", () => {
        expect(isExhaustedError("Insufficient balance of 0x2::usdc::USDC for owner 0xabc")).toBe(
            true,
        );
    });

    test("matches the no-coins shortage error", () => {
        expect(isExhaustedError("No coins of type 0x2::deep::DEEP found for address")).toBe(true);
    });

    test("does not match an unrelated transaction failure", () => {
        expect(isExhaustedError("MoveAbort in 0x2::coin: 1")).toBe(false);
    });
});

describe("stringifyExecutionError", () => {
    test("null/undefined collapse to a stable string", () => {
        expect(stringifyExecutionError(null)).toBe("unknown error");
        expect(stringifyExecutionError(undefined)).toBe("unknown error");
    });

    test("passes a bare string through", () => {
        expect(stringifyExecutionError("boom")).toBe("boom");
    });

    test("reads .message off a structured ExecutionError", () => {
        expect(stringifyExecutionError({ message: "MoveAbort", command: 0 })).toBe("MoveAbort");
    });

    test("falls back to JSON for an opaque object", () => {
        expect(stringifyExecutionError({ code: 7 })).toBe('{"code":7}');
    });
});

describe("classifyFailure", () => {
    test("classifies exhaustion", () => {
        expect(classifyFailure("Transaction failed: No coins found")).toMatchObject({
            success: false,
            kind: "exhausted",
        });
    });

    test("classifies any other fault as tx_failed", () => {
        expect(classifyFailure("Transaction failed: MoveAbort 3")).toMatchObject({
            success: false,
            kind: "tx_failed",
        });
    });
});

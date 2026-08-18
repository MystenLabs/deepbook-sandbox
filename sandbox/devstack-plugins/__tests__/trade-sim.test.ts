// Unit tests for the trade-sim's interior-pair placement (SEDEFI-455).
//
// The invariant that matters: the pair NEVER reaches the measured touch —
// the bid stays strictly above the real best bid and strictly below the real
// best ask (mirrored for the ask). A pair that lands ON either side executes
// against the pin-era book, which is exactly the quote-draining stall this
// placement replaces (a guessed center above the real ask market-bought the
// manager's whole quote leg in three ticks, then aborted code 3 forever).

import { describe, expect, it } from "vitest";

import { interiorPair, isStaleRefError } from "../trade-sim.ts";

describe("interiorPair", () => {
    it("clamps the walked center into a tight interior (the live DEEP_SUI case)", () => {
        // Touch measured on the fork: 2335 / 2338, guessed center 2341 — the
        // old placement put the bid at 2339, ON TOP of the real ask.
        expect(interiorPair(2335n, 2338n, 2341n)).toEqual({ bid: 2336n, ask: 2337n });
    });

    it("slides with the walk inside a wide interior, strictly inside", () => {
        expect(interiorPair(2000n, 2100n, 2050n)).toEqual({ bid: 2049n, ask: 2050n });
        // Clamped at both edges: never AT the touch, one tick clear of it.
        expect(interiorPair(2000n, 2100n, 1900n)).toEqual({ bid: 2001n, ask: 2002n });
        expect(interiorPair(2000n, 2100n, 2500n)).toEqual({ bid: 2098n, ask: 2099n });
    });

    it("collapses a 2-tick spread onto the single interior tick", () => {
        // bid === ask: the ask self-fills the resting bid at placement.
        expect(interiorPair(2335n, 2337n, 9999n)).toEqual({ bid: 2336n, ask: 2336n });
    });

    it("returns null when the spread has no interior", () => {
        expect(interiorPair(2335n, 2336n, 2335n)).toBeNull(); // touching book
        expect(interiorPair(2336n, 2336n, 2336n)).toBeNull(); // locked book
        expect(interiorPair(2340n, 2336n, 2338n)).toBeNull(); // crossed book
    });

    it("keeps the walked shape on an empty book", () => {
        expect(interiorPair(null, null, 100n)).toEqual({ bid: 98n, ask: 102n });
        // Price floor: the bid cannot go below one tick.
        expect(interiorPair(null, null, 2n)).toEqual({ bid: 1n, ask: 4n });
    });

    it("stays below the ask side when bids are empty", () => {
        expect(interiorPair(null, 2338n, 9999n)).toEqual({ bid: 2336n, ask: 2337n });
        expect(interiorPair(null, 2n, 9999n)).toBeNull(); // no room above tick 1
    });

    it("stays above the bid side when asks are empty", () => {
        expect(interiorPair(2335n, null, 1n)).toEqual({ bid: 2336n, ask: 2337n });
        expect(interiorPair(2335n, null, 9999n)).toEqual({ bid: 9998n, ask: 9999n });
    });
});

// The whale's gas coin is shared with deep-funding / usdc-funding / the
// faucet, so another member can bump it between our read and our execute —
// at boot the trading-dashboard member's DEEP+USDC top-up does exactly that,
// and the lost race used to fail the member and the whole `devstack up`.
// These are the real strings the fork returns (URL-encoded through gRPC).
describe("isStaleRefError", () => {
    const cause = (message: string) => ({ _tag: "SuiPluginError", message });

    it("matches the URL-ENCODED digest rejection the fork actually sends", () => {
        expect(
            isStaleRefError(
                cause(
                    "sui fork mode: impersonate(0x9548232f9cebbc1eec56cfb25b99f61e17924b4908248c260c8d70100c59c70d) " +
                        "failed: Error%20checking%20transaction%20input%20objects:%20Invalid%20Object%20digest%20" +
                        "for%20object%200xc866352dd2574aa14752dd09afca89cd993f573c59218ff278c3dafbd24ca714.%20" +
                        "Expected%20digest%20:%209orQz3jghM3RTZPTKhnepiZJWGVvZwNRi92ukRvx8Cdb",
                ),
            ),
        ).toBe(true);
    });

    it("matches the decoded form too", () => {
        expect(
            isStaleRefError(
                cause(
                    "Error checking transaction input objects: Invalid Object digest for object 0xc866352d. " +
                        "Expected digest : 9orQz3jgh",
                ),
            ),
        ).toBe(true);
    });

    it("matches the version-checked sibling (BalanceManager / DEEP source coin)", () => {
        expect(isStaleRefError(cause("Object 0xfea1b624 is not available for consumption"))).toBe(
            true,
        );
    });

    it("does NOT retry an on-chain revert or an unrelated failure", () => {
        // A revert is deterministic — retrying it just burns the whale's gas.
        expect(isStaleRefError(cause("tx ABC reverted: MoveAbort ... code 3"))).toBe(false);
        expect(
            isStaleRefError(cause("Balance of gas object 1 is lower than the needed amount")),
        ).toBe(false);
        expect(isStaleRefError(cause("object 0xdead not found on the fork"))).toBe(false);
    });

    it("survives a lone '%' instead of throwing on decode", () => {
        expect(isStaleRefError(cause("100% failure: Invalid Object digest for object 0x1"))).toBe(
            true,
        );
        expect(isStaleRefError(cause("100% unrelated"))).toBe(false);
    });
});

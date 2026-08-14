// Unit tests for the trade-sim's interior-pair placement (SEDEFI-455).
//
// The invariant that matters: the pair NEVER reaches the measured touch —
// the bid stays strictly above the real best bid and strictly below the real
// best ask (mirrored for the ask). A pair that lands ON either side executes
// against the pin-era book, which is exactly the quote-draining stall this
// placement replaces (a guessed center above the real ask market-bought the
// manager's whole quote leg in three ticks, then aborted code 3 forever).

import { describe, expect, it } from "vitest";

import { interiorPair } from "../trade-sim.ts";

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

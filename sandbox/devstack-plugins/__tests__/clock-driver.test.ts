// Unit tests for the fork clock driver (SEDEFI-317 / DBSF-013, slice 1).
//
// The invariants worth pinning are the ones that go wrong SILENTLY on a fork:
// advancing past wall time hides fills above the DeepBook server's window just
// as thoroughly as never advancing hides them below it, and neither shows up
// as an error anywhere — only as an empty Price panel.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
    clockDriverMember,
    emptyClockDriverStats,
    makeClockSync,
    MIN_ADVANCE_MS,
    MIN_INTERVAL_MS,
    type ForkClockSurface,
} from "../clock-driver.ts";

/** A fake fork admin surface with a movable Clock, recording every advance. */
const fakeFork = (clock: number, opts?: { failStatus?: boolean; failAdvance?: boolean }) => {
    const advances: number[] = [];
    let current = clock;
    const fork: ForkClockSurface = {
        status: Effect.suspend(() =>
            opts?.failStatus
                ? Effect.fail(new Error("fork status read failed"))
                : Effect.succeed({ clock: current }),
        ),
        advanceClock: (ms: number) => {
            if (opts?.failAdvance) return Effect.fail(new Error("advance-clock failed"));
            return Effect.sync(() => {
                advances.push(ms);
                current += ms;
            });
        },
    };
    return { fork, advances, clockNow: () => current };
};

const WALL = 1_760_000_000_000;

describe("makeClockSync", () => {
    it("advances by exactly the deficit, landing the Clock ON wall time", () => {
        const behind = 14 * 24 * 60 * 60 * 1000; // a two-week checkpoint pin
        const { fork, advances, clockNow } = fakeFork(WALL - behind);
        const stats = emptyClockDriverStats();

        const closed = Effect.runSync(makeClockSync(fork, stats, () => WALL));

        expect(closed).toBe(behind);
        expect(advances).toEqual([behind]);
        // The invariant: never past wall. An overshoot stamps fills in the
        // future, where the server's 24h window cannot see them either.
        expect(clockNow()).toBe(WALL);
        expect(stats.advances).toBe(1);
        expect(stats.lastAdvanceMs).toBe(behind);
        expect(stats.clockMs).toBe(WALL);
    });

    it("skips sub-threshold drift instead of sealing a checkpoint for it", () => {
        const { fork, advances } = fakeFork(WALL - (MIN_ADVANCE_MS - 1));
        const stats = emptyClockDriverStats();

        expect(Effect.runSync(makeClockSync(fork, stats, () => WALL))).toBe(0);
        expect(advances).toEqual([]);
        expect(stats.skipped).toBe(1);
        expect(stats.advances).toBe(0);
    });

    it("never advances when the Clock is already AHEAD of wall", () => {
        // Another advancer (trade-sim, seed-trades, clock:sync) overshot.
        const { fork, advances, clockNow } = fakeFork(WALL + 60_000);
        const stats = emptyClockDriverStats();

        expect(Effect.runSync(makeClockSync(fork, stats, () => WALL))).toBe(0);
        expect(advances).toEqual([]);
        expect(clockNow()).toBe(WALL + 60_000); // forward-only: cannot pull back
        expect(stats.skipped).toBe(1);
    });

    it("re-measures from fork.status every cycle, so a foreign advance can't compound", () => {
        const { fork, advances, clockNow } = fakeFork(WALL - 10_000);
        const stats = emptyClockDriverStats();

        Effect.runSync(makeClockSync(fork, stats, () => WALL));
        // Something else moves the Clock; a driver that cached its own value
        // would now advance a second time off the stale one and overshoot.
        Effect.runSync(fork.advanceClock(5_000));
        Effect.runSync(makeClockSync(fork, stats, () => WALL));

        expect(advances).toEqual([10_000, 5_000]); // no third, oversized advance
        expect(clockNow()).toBe(WALL + 5_000);
        expect(stats.advances).toBe(1);
        expect(stats.skipped).toBe(1);
    });

    it("propagates a failed status read without advancing", () => {
        const { fork, advances } = fakeFork(WALL - 10_000, { failStatus: true });
        const stats = emptyClockDriverStats();

        expect(() => Effect.runSync(makeClockSync(fork, stats, () => WALL))).toThrow();
        expect(advances).toEqual([]);
        expect(stats.advances).toBe(0);
    });

    it("propagates a failed advance and does not claim the Clock moved", () => {
        const { fork } = fakeFork(WALL - 10_000, { failAdvance: true });
        const stats = emptyClockDriverStats();

        expect(() => Effect.runSync(makeClockSync(fork, stats, () => WALL))).toThrow();
        expect(stats.advances).toBe(0);
        expect(stats.lastAdvanceMs).toBeNull();
        expect(stats.clockMs).toBe(WALL - 10_000); // last OBSERVED clock, unmoved
    });
});

describe("clockDriverMember config", () => {
    it("rejects an interval below the floor", () => {
        // The guard runs before any dep is touched, so stubs are enough.
        const stub = { sui: {} as never, registryInit: {} as never };
        expect(() => clockDriverMember({ ...stub, intervalMs: MIN_INTERVAL_MS - 1 })).toThrow(
            /CLOCK_INTERVAL_MS/,
        );
        expect(() => clockDriverMember({ ...stub, intervalMs: Number.NaN })).toThrow(
            /CLOCK_INTERVAL_MS/,
        );
    });
});

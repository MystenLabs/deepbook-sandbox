// Fork clock driver as a devstack member (SEDEFI-317 / DBSF-013, slice 1 of 2).
//
// The fork's on-chain Clock starts at the FORK_CHECKPOINT pin and NEVER ticks
// on its own (SUI-FORK-ISSUES #6 / SEDEFI-453): checkpoints seal with whatever
// the Clock currently says, so every transaction the sandbox makes is stamped
// weeks in the past. That is not cosmetic — the DeepBook server windows by
// WALL time while filtering on those checkpoint timestamps:
//
//     crates/server/src/server.rs:789  let end_time   = SystemTime::now()…;
//     crates/server/src/server.rs:795  let start_time = end_time - (24*60*60*1000);
//
// so a fresh fill lands ~2 weeks BELOW the window and /ticker reports no
// last_price at all — which is exactly what the trading dashboard's Mid /
// -10% / +10% buttons price off (dashboard/src/lib/fork.ts:213). A stack
// whose clock never moves shows an empty Price panel and useless order-price
// defaults, no matter how much it trades.
//
// This member is the stack's SINGLE clock authority: every CLOCK_INTERVAL_MS
// it reads the fork's Clock and advances it to wall time. Two invariants:
//
//   - Forward-only, and never past wall. The chain Clock cannot go back, and
//     a Clock AHEAD of wall is worse than one behind — fills stamped in the
//     future sit ABOVE the server's window and vanish from every query until
//     wall time catches up. So each tick advances by exactly the measured
//     deficit; there is no fixed step to overshoot with.
//   - The deficit is measured from `fork.status` every tick, never from a
//     locally tracked clock. Anything else in the stack that seals a
//     checkpoint (trade-sim, seed-trades, a manual clock:sync) moves the
//     Clock underneath us, and a cached value would then read low and
//     advance us past wall. That drift is why trade-sim no longer advances
//     the Clock itself — see its header.
//
// Slice 2 (the rest of DBSF-013) turns this into the Hermes -> advance-clock
// -> submit oracle loop: same cadence, with a fetched VAA's publish_time as
// the advance target and a Pyth update PTB after it. Deliberately NOT here —
// that half carries the Wormhole guardian-rotation risk (SEDEFI-319) and wants
// a hostService with a /status port, while this half is pure fork admin and
// fixes the dashboard's prices on its own.
//
// `pnpm clock:sync` (scripts/sync-fork-clock.ts) stays: it drives the same
// advance over `docker exec`, which still works with CLOCK_DRIVER_DISABLED=1
// or when the supervisor is down.

import { Duration, Effect, Schedule } from "effect";
import { definePlugin, type sui } from "@mysten-incubation/devstack";

import { memberError } from "./container-util.ts";
import type { registryInitMember } from "./registry-init.ts";

const MEMBER = "clock-driver";
const fail = memberError(MEMBER);

/** Tick cadence. The Clock falls behind by exactly one interval between
 *  ticks, so this is also the stack's worst-case clock lag — it only needs to
 *  be small relative to the server's windows (24h /ticker, 1m OHLCV buckets),
 *  and every tick seals a checkpoint the indexer then ingests. */
export const DEFAULT_INTERVAL_MS = 5_000;
export const MIN_INTERVAL_MS = 500;
/** Don't seal a checkpoint for sub-second drift (another advancer just ran). */
export const MIN_ADVANCE_MS = 250;
/** Log cadence for a persistent failure, in consecutive failures. */
const FAILURE_LOG_EVERY = 25;

/** The slice of devstack's fork admin surface this member drives. Structural
 *  so tests can hand it a fake — the real one is `deps.sui.fork`. */
export type ForkClockSurface = {
    readonly status: Effect.Effect<{ readonly clock: number }, unknown>;
    readonly advanceClock: (intervalMs: number) => Effect.Effect<void, unknown>;
};

export type ClockDriverOptions = {
    sui: ReturnType<typeof sui>;
    /** ordering only: advancing the Clock seals a checkpoint, and a fresh
     *  chain's FIRST commit panic-aborts the fork unless the framework is
     *  pre-warmed (SUI-FORK-ISSUES #9) — registry-init does that warm-up. */
    registryInit: ReturnType<typeof registryInitMember>;
    /** tick cadence (default 5s; env CLOCK_INTERVAL_MS). */
    intervalMs?: number;
};

export type ClockDriverStats = {
    /** advances that actually sealed a checkpoint */
    advances: number;
    /** ticks that found the Clock already at wall (< MIN_ADVANCE_MS behind) */
    skipped: number;
    failures: number;
    consecutiveFailures: number;
    lastError: string | null;
    /** fork Clock as of the last successful status read (ms since epoch) */
    clockMs: number | null;
    /** deficit closed by the last advance (ms) */
    lastAdvanceMs: number | null;
    /** the one-off jump from the checkpoint pin to wall time at boot (ms) */
    bootCatchUpMs: number | null;
};

/** Fresh zeroed stats — one per member start. */
export const emptyClockDriverStats = (): ClockDriverStats => ({
    advances: 0,
    skipped: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastError: null,
    clockMs: null,
    lastAdvanceMs: null,
    bootCatchUpMs: null,
});

/**
 * One measure-and-close cycle, as an Effect yielding the deficit it closed
 * (0 when the Clock was already at wall). Mutates `stats` in place.
 *
 * Extracted from the member so the invariants that matter — advance by
 * EXACTLY the measured deficit, never overshoot wall, always re-measure from
 * `fork.status` rather than a cached clock — are unit-testable against a fake
 * fork. `now` is injectable for the same reason; it defaults to `Date.now`.
 */
export const makeClockSync = (
    fork: ForkClockSurface,
    stats: ClockDriverStats,
    now: () => number = Date.now,
): Effect.Effect<number, unknown> =>
    Effect.gen(function* () {
        const status = yield* fork.status;
        stats.clockMs = status.clock;
        const deficit = now() - status.clock;
        if (deficit < MIN_ADVANCE_MS) {
            stats.skipped += 1;
            return 0;
        }
        yield* fork.advanceClock(deficit);
        stats.advances += 1;
        stats.lastAdvanceMs = deficit;
        stats.clockMs = status.clock + deficit;
        stats.consecutiveFailures = 0;
        return deficit;
    });

export function clockDriverMember(opts: ClockDriverOptions) {
    const disabled = process.env.CLOCK_DRIVER_DISABLED === "1";
    const intervalMs = Number(
        process.env.CLOCK_INTERVAL_MS ?? opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
        throw new Error(
            `clock-driver: CLOCK_INTERVAL_MS must be a number >= ${MIN_INTERVAL_MS} (got ${intervalMs})`,
        );
    }

    return definePlugin({
        id: MEMBER,
        role: "service",
        section: "service",
        dependsOn: { sui: opts.sui, registryInit: opts.registryInit },
        start: (deps) =>
            Effect.gen(function* () {
                if (disabled) {
                    return {
                        enabled: false as const,
                        reason: "CLOCK_DRIVER_DISABLED=1",
                        intervalMs,
                    };
                }
                const fork = deps.sui.fork;
                if (fork === null) {
                    return yield* Effect.fail(
                        fail(
                            "mode",
                            "clock-driver requires sui mode:'fork' (no fork admin surface to advance)",
                        ),
                    );
                }

                const stats = emptyClockDriverStats();
                /** Fails loudly — each caller below decides whether a failure
                 *  is fatal (boot) or swallowed (steady state). */
                const syncOnce = makeClockSync(fork, stats);

                // Boot catch-up: one jump from the checkpoint pin (weeks back)
                // to wall time, before anything else trades. Fatal if it
                // fails — a stack whose clock never left the pin produces
                // fills no time-windowed reader can see, and silently.
                const bootCatchUp = yield* syncOnce.pipe(
                    Effect.catch((cause) =>
                        Effect.fail(
                            fail(
                                "clock",
                                "boot clock catch-up failed — the fork's Clock is still at the " +
                                    "checkpoint pin, so every fill will be invisible to the " +
                                    "server's wall-relative windows",
                                cause,
                            ),
                        ),
                    ),
                );
                stats.bootCatchUpMs = bootCatchUp;
                if (bootCatchUp > 0) {
                    console.error(
                        `[clock-driver] boot catch-up: advanced the fork Clock ` +
                            `${Math.round(bootCatchUp / 1000)}s to wall time ` +
                            `(now ${new Date(stats.clockMs ?? Date.now()).toISOString()}); ` +
                            `holding it there every ${intervalMs}ms`,
                    );
                }

                // Steady state: a transient fork RPC hiccup must not take the
                // member (or the stack) down — the next tick re-measures from
                // `fork.status` and closes whatever deficit accumulated.
                const tick = syncOnce.pipe(
                    Effect.catch((cause) =>
                        Effect.sync(() => {
                            stats.failures += 1;
                            stats.consecutiveFailures += 1;
                            stats.lastError = String(
                                (cause as { message?: string }).message ?? cause,
                            ).slice(0, 300);
                            if (
                                stats.consecutiveFailures === 1 ||
                                stats.consecutiveFailures % FAILURE_LOG_EVERY === 0
                            ) {
                                console.error(
                                    `[clock-driver] advance failed (${stats.consecutiveFailures} ` +
                                        `consecutive): ${stats.lastError}`,
                                );
                            }
                            return 0;
                        }),
                    ),
                );

                // Long-lived loop dies with the plugin scope (same shape as
                // trade-sim's: failures already swallowed per-iteration).
                yield* Effect.forkScoped(
                    Effect.repeat(tick, Schedule.spaced(Duration.millis(intervalMs))),
                );

                return { enabled: true as const, intervalMs, stats };
            }),
    });
}

/**
 * Integration / E2E tests for the oracle service.
 *
 * Unlike deploy-all-e2e and deploy-pipeline tests, this file assumes
 * the localnet stack is already running (via `pnpm deploy-all`). This
 * makes it fast (~30-60s) and independently runnable for oracle iteration.
 *
 * The entire suite is skipped if the oracle status endpoint is unreachable.
 *
 * Prerequisites:
 *   - Localnet stack deployed and running (`pnpm deploy-all`)
 *   - Oracle service healthy on http://127.0.0.1:9010
 *
 * Usage:
 *   cd sandbox
 *   pnpm test:integration oracle-service
 */

import { describe, test, expect, beforeAll } from "vitest";

const ORACLE_URL = "http://127.0.0.1:9010";

/** Shape returned by the oracle status endpoint */
interface OracleStatusResponse {
    status: string;
    updates: number;
    errors: number;
    lastUpdate: string | null;
    prices: {
        sui: string | null;
        deep: string | null;
        usdc: string | null;
    };
}

async function fetchStatus(): Promise<OracleStatusResponse> {
    const res = await fetch(`${ORACLE_URL}/`, {
        signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Status endpoint returned ${res.status}`);
    return res.json() as Promise<OracleStatusResponse>;
}

/** Check if the oracle service is reachable. Returns true if it responds. */
async function isOracleReachable(): Promise<boolean> {
    try {
        await fetch(ORACLE_URL, { signal: AbortSignal.timeout(3_000) });
        return true;
    } catch {
        return false;
    }
}

describe("oracle service E2E (pre-deployed stack)", async () => {
    const reachable = await isOracleReachable();

    // Skip the entire suite if the oracle service is not running.
    // This prevents false failures in CI when this test runs before deploy suites,
    // and gives developers a clear message about what's needed.
    beforeAll(() => {
        if (!reachable) {
            console.log(
                "\n⚠️  Oracle service not reachable at %s — skipping suite.\n" +
                    "   Run `pnpm deploy-all` first to start the localnet stack.\n",
                ORACLE_URL,
            );
        }
    });

    test.skipIf(!reachable)("status endpoint returns valid JSON", async () => {
        const body = await fetchStatus();

        // Validate top-level shape
        expect(body.status).toBe("ok");
        expect(typeof body.updates).toBe("number");
        expect(typeof body.errors).toBe("number");
        expect(body.prices).toBeDefined();

        // Prices object has all three feed keys
        expect(body.prices).toHaveProperty("sui");
        expect(body.prices).toHaveProperty("deep");
        expect(body.prices).toHaveProperty("usdc");

        // lastUpdate is either null (no updates yet) or a valid ISO timestamp
        if (body.lastUpdate !== null) {
            expect(new Date(body.lastUpdate).getTime()).not.toBeNaN();
        }
    });

    test.skipIf(!reachable)(
        "reports non-null prices",
        async () => {
            // Wait long enough for at least one update cycle (10s interval + buffer)
            const deadline = Date.now() + 30_000;
            let body: OracleStatusResponse | null = null;

            while (Date.now() < deadline) {
                body = await fetchStatus();
                if (body.updates > 0 && body.prices.sui !== null) break;
                await new Promise((r) => setTimeout(r, 2_000));
            }

            expect(body).not.toBeNull();
            expect(body!.updates).toBeGreaterThan(0);
            expect(body!.prices.sui).not.toBeNull();
            expect(body!.prices.deep).not.toBeNull();
            expect(body!.prices.usdc).not.toBeNull();

            // Prices should be dollar-formatted strings
            expect(body!.prices.sui).toMatch(/^\$/);
            expect(body!.prices.deep).toMatch(/^\$/);
            expect(body!.prices.usdc).toMatch(/^\$/);
        },
        60_000,
    );

    test.skipIf(!reachable)(
        "updates approximately every 10 seconds",
        async () => {
            // Record the updateCount at multiple points over ~35 seconds
            // and measure the time between count increments.
            const samples: { time: number; updates: number }[] = [];
            const startTime = Date.now();
            const duration = 35_000;

            while (Date.now() - startTime < duration) {
                const body = await fetchStatus();
                samples.push({ time: Date.now(), updates: body.updates });
                await new Promise((r) => setTimeout(r, 1_000));
            }

            // Find timestamps where updateCount incremented
            const increments: number[] = [];
            for (let i = 1; i < samples.length; i++) {
                if (samples[i].updates > samples[i - 1].updates) {
                    increments.push(samples[i].time);
                }
            }

            // We should observe at least 2 increments in 35s (updates every 10s)
            expect(
                increments.length,
                `Expected ≥2 update increments in ${duration / 1000}s, got ${increments.length}`,
            ).toBeGreaterThanOrEqual(2);

            // Measure intervals between successive increments
            const intervals: number[] = [];
            for (let i = 1; i < increments.length; i++) {
                intervals.push(increments[i] - increments[i - 1]);
            }

            if (intervals.length > 0) {
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

                // Each interval should be between 5s and 20s (generous tolerance)
                for (const interval of intervals) {
                    expect(
                        interval,
                        `Interval ${interval}ms outside tolerance [5000, 20000]`,
                    ).toBeGreaterThanOrEqual(5_000);
                    expect(
                        interval,
                        `Interval ${interval}ms outside tolerance [5000, 20000]`,
                    ).toBeLessThanOrEqual(20_000);
                }

                // Average should be between 8s and 15s
                expect(
                    avgInterval,
                    `Average interval ${avgInterval}ms outside [8000, 15000]`,
                ).toBeGreaterThanOrEqual(8_000);
                expect(
                    avgInterval,
                    `Average interval ${avgInterval}ms outside [8000, 15000]`,
                ).toBeLessThanOrEqual(15_000);
            }
        },
        60_000,
    );

    test.skipIf(!reachable)(
        "handles rapid queries (100 requests)",
        async () => {
            // Fire 100 requests concurrently
            const requests = Array.from({ length: 100 }, () =>
                fetch(`${ORACLE_URL}/`, { signal: AbortSignal.timeout(10_000) }),
            );

            const responses = await Promise.all(requests);

            for (const res of responses) {
                expect(res.status).toBe(200);
            }

            // All should return valid JSON
            const bodies = await Promise.all(responses.map((r) => r.json()));
            for (const body of bodies) {
                expect(body.status).toBe("ok");
            }
        },
        30_000,
    );

    test.skipIf(!reachable)(
        "frequent queries return cached prices",
        async () => {
            // Fire 20 queries in quick succession (~2s window).
            // Between updates, all should return the same updateCount.
            // If the window straddles an update boundary, we may see at most 2 distinct counts.
            const bodies: OracleStatusResponse[] = [];

            for (let i = 0; i < 20; i++) {
                bodies.push(await fetchStatus());
                await new Promise((r) => setTimeout(r, 100));
            }

            // Queries never trigger extra updates — at most 1 natural update can occur
            // during the ~2s window, so we allow at most 2 distinct counts.
            const counts = new Set(bodies.map((b) => b.updates));
            expect(
                counts.size,
                `Expected ≤2 distinct updateCounts within ~2s, ` +
                    `but saw ${counts.size}: ${[...counts].join(", ")}`,
            ).toBeLessThanOrEqual(2);
        },
        10_000,
    );

    test.skipIf(!reachable)("continues running with errors", async () => {
        // The service should always respond, even if it has accumulated errors.
        // We just verify the errors field exists and the service is still alive.
        const body = await fetchStatus();

        expect(typeof body.errors).toBe("number");
        expect(body.errors).toBeGreaterThanOrEqual(0);

        // Service is still operational regardless of error count
        expect(body.status).toBe("ok");

        // A second query should also succeed (service didn't crash)
        const body2 = await fetchStatus();
        expect(body2.status).toBe("ok");
    });
});

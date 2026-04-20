/**
 * Integration test for the /services control endpoints.
 *
 * Assumes the localnet stack is already running (via `pnpm deploy-all`).
 * The suite is skipped if the api service is unreachable.
 *
 * Prerequisites:
 *   - Localnet stack deployed and running (`pnpm deploy-all`)
 *   - Sandbox api healthy on http://127.0.0.1:9009
 *   - Oracle service healthy on http://127.0.0.1:9010
 *
 * Usage:
 *   cd sandbox
 *   pnpm test:integration services-control
 */

import { describe, test, expect, beforeAll } from "vitest";

const API_URL = "http://127.0.0.1:9009";
const ORACLE_URL = "http://127.0.0.1:9010";
const RECOVERY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_000;

async function isReachable(url: string): Promise<boolean> {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return r.ok;
    } catch {
        return false;
    }
}

async function waitUntilHealthy(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isReachable(url)) return true;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
}

describe("/services control endpoints (pre-deployed stack)", async () => {
    const reachable = await isReachable(API_URL);

    beforeAll(() => {
        if (!reachable) {
            console.log(
                "\n⚠️  Sandbox api not reachable at %s — skipping suite.\n" +
                    "   Run `pnpm deploy-all` first to start the localnet stack.\n",
                API_URL,
            );
        }
    });

    test.skipIf(!reachable)("rejects unknown service name with 400", async () => {
        const r = await fetch(`${API_URL}/services/not-a-service/restart`, { method: "POST" });
        expect(r.status).toBe(400);
        const body = (await r.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/Invalid service/);
    });

    test.skipIf(!reachable)("rejects unknown action with 404", async () => {
        // Route pattern restricts :action to stop|restart; anything else is unmatched.
        const r = await fetch(`${API_URL}/services/oracle-service/delete`, { method: "POST" });
        expect(r.status).toBe(404);
    });

    test.skipIf(!reachable)(
        "restart oracle-service → 202 → oracle recovers",
        async () => {
            // Sanity: oracle is up before we kick it.
            expect(await isReachable(ORACLE_URL)).toBe(true);

            const r = await fetch(`${API_URL}/services/oracle-service/restart`, { method: "POST" });
            expect(r.status).toBe(202);
            const body = (await r.json()) as { ok: boolean; service: string; action: string };
            expect(body).toMatchObject({ ok: true, service: "oracle-service", action: "restart" });

            // Wait for oracle to come back. Docker restart + Node startup takes a few seconds.
            const recovered = await waitUntilHealthy(ORACLE_URL, RECOVERY_TIMEOUT_MS);
            expect(recovered).toBe(true);
        },
        RECOVERY_TIMEOUT_MS + 10_000,
    );

    test.skipIf(!reachable)(
        "stop then start oracle-service → endpoint drops then recovers",
        async () => {
            const stop = await fetch(`${API_URL}/services/oracle-service/stop`, { method: "POST" });
            expect(stop.status).toBe(202);

            // Wait briefly for docker to actually stop the container.
            await new Promise((resolve) => setTimeout(resolve, 3_000));

            const start = await fetch(`${API_URL}/services/oracle-service/start`, {
                method: "POST",
            });
            expect(start.status).toBe(202);
            const body = (await start.json()) as { ok: boolean; service: string; action: string };
            expect(body).toMatchObject({ ok: true, service: "oracle-service", action: "start" });

            const recovered = await waitUntilHealthy(ORACLE_URL, RECOVERY_TIMEOUT_MS);
            expect(recovered).toBe(true);
        },
        RECOVERY_TIMEOUT_MS + 15_000,
    );
});

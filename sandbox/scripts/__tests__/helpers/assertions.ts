import { execFileSync } from "child_process";
import { expect } from "vitest";

/**
 * Assert that a string is a valid Sui object/package ID (0x-prefixed hex, 64 hex chars).
 */
export function expectValidSuiId(id: string): void {
    expect(id).toMatch(/^0x[a-fA-F0-9]{64}$/);
}

/**
 * Poll a URL until it responds (any HTTP status = server is up).
 * Throws if the URL does not respond within the timeout.
 */
export async function waitForUrl(
    url: string,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<Response> {
    const { timeoutMs = 60_000, intervalMs = 2_000, label = url } = opts;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (res.status > 0) return res;
        } catch {
            // connection refused, timeout, or similar — keep polling
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`${label} did not respond within ${timeoutMs}ms`);
}

/**
 * Assert that a Docker container with the given name is running.
 */
export function expectContainerRunning(name: string): void {
    const output = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
        encoding: "utf-8",
    }).trim();
    expect(output).toBe("true");
}

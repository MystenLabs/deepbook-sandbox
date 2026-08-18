// Foreign devstack supervisor discovery and teardown, shared by
// `scripts/stack.ts` (`pnpm deploy-all` / `pnpm down`) and unit-tested in
// isolation — stack.ts dispatches its CLI at module top level, so its logic
// can't be imported directly.

import { spawnSync } from "node:child_process";

/** What a supervisor looks like in a process table, as a `pgrep -f` ERE. Both
 *  alternatives matter: the `pnpm exec devstack up` wrapper chain AND the bare
 *  devstack CLI entry (`.../devstack/dist/cli/main.mjs up`) — the entry is the
 *  process actually holding devstack's per-stack lock, and an orphan can
 *  survive as just that process after its pnpm/sh parents die with the
 *  terminal, where the old literal `"devstack up"` match finds nothing. */
export const SUPERVISOR_PATTERN = "devstack up|devstack/dist/cli/main\\.mjs up";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/** Foreign `devstack up` supervisors, split by whether a terminal owns them.
 *  Orphans (tty `??`: a dead session's background process) have no Ctrl-C to
 *  press, so teardown stops them itself; attached ones stay the user's call. */
export const foreignSupervisors = (
    pattern: string = SUPERVISOR_PATTERN,
): { attached: number[]; orphaned: number[] } => {
    const found: { attached: number[]; orphaned: number[] } = { attached: [], orphaned: [] };
    const pgrep = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    for (const line of (pgrep.stdout ?? "").split("\n")) {
        const pid = Number(line.trim());
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const tty = spawnSync("ps", ["-o", "tty=", "-p", `${pid}`], {
            encoding: "utf8",
        }).stdout?.trim();
        if (tty === undefined || tty === "") continue; // exited between pgrep and ps
        // "??" is BSD/macOS ps for "no controlling terminal"; procps prints "?".
        (tty === "??" || tty === "?" || tty === "-" ? found.orphaned : found.attached).push(pid);
    }
    return found;
};

/** Stop every ORPHANED supervisor matching `pattern`; never signals attached
 *  ones (they're reported for the caller to surface). Returns the orphan pids
 *  signalled (`reaped`) and any still alive after escalation (`survivors`). */
export const reapOrphanedSupervisors = async (
    pattern: string = SUPERVISOR_PATTERN,
    timeoutMs = 90_000,
): Promise<{ attached: number[]; reaped: number[]; survivors: number[] }> => {
    const { attached, orphaned } = foreignSupervisors(pattern);
    const signal = (pids: number[], sig: NodeJS.Signals) => {
        for (const pid of pids) {
            try {
                process.kill(pid, sig);
            } catch {
                // already gone
            }
        }
    };
    const waitDead = async (pids: number[], deadline: number): Promise<number[]> => {
        let alive = pids.filter(pidAlive);
        while (alive.length > 0 && Date.now() < deadline) {
            await sleep(250);
            alive = alive.filter(pidAlive);
        }
        return alive;
    };
    signal(orphaned, "SIGINT"); // devstack's graceful-shutdown signal
    let survivors = await waitDead(orphaned, Date.now() + timeoutMs);
    if (survivors.length > 0) {
        signal(survivors, "SIGTERM");
        survivors = await waitDead(survivors, Date.now() + 2_000);
    }
    return { attached, reaped: orphaned, survivors };
};

import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { foreignSupervisors, pidAlive, reapOrphanedSupervisors } from "../stack-supervisors";

// Real-process tests: each fake supervisor is a detached `node -e` child with a
// unique marker in its argv, so `pgrep -f <marker>` finds it and nothing else —
// in particular never a real devstack supervisor on the machine running the
// suite. The attached-terminal branch is not covered here: faking a controlling
// tty needs `script(1)`, whose flags differ between macOS and Linux CI.

let markerSeq = 0;
const uniqueMarker = () => `stack-supervisors-test-${process.pid}-${markerSeq++}`;

const spawned: ChildProcess[] = [];

/** A fake orphan: no tty (detached + ignored stdio), marker in argv, and a
 *  configurable SIGINT reaction so escalation is testable. */
const spawnFakeSupervisor = (marker: string, onSigint = "() => process.exit(0)"): number => {
    const child = spawn(
        process.execPath,
        ["-e", `process.on('SIGINT', ${onSigint}); setInterval(() => {}, 1000);`, marker],
        { detached: true, stdio: "ignore" },
    );
    if (child.pid === undefined) throw new Error("failed to spawn fake supervisor");
    child.unref();
    spawned.push(child);
    return child.pid;
};

const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 50));
    }
};

afterEach(() => {
    for (const child of spawned.splice(0)) {
        try {
            if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
        } catch {
            // already gone
        }
    }
});

describe("foreignSupervisors", () => {
    test("classifies a detached process matching the pattern as orphaned", async () => {
        const marker = uniqueMarker();
        const pid = spawnFakeSupervisor(marker);
        await until(() => foreignSupervisors(marker).orphaned.includes(pid));
        expect(foreignSupervisors(marker).attached).toEqual([]);
    });

    test("matches by ERE alternation (the production pattern is one)", async () => {
        const unmatched = uniqueMarker();
        const marker = uniqueMarker();
        const pid = spawnFakeSupervisor(marker);
        await until(() => foreignSupervisors(`${unmatched}|${marker}`).orphaned.includes(pid));
    });
});

describe("reapOrphanedSupervisors", () => {
    test("SIGINTs an orphaned supervisor and waits for it to exit", async () => {
        const marker = uniqueMarker();
        const pid = spawnFakeSupervisor(marker);
        await until(() => foreignSupervisors(marker).orphaned.includes(pid));

        const result = await reapOrphanedSupervisors(marker, 4_000);

        expect(result.reaped).toContain(pid);
        expect(result.survivors).toEqual([]);
        expect(result.attached).toEqual([]);
        expect(pidAlive(pid)).toBe(false);
    });

    test("escalates to SIGTERM when SIGINT is ignored", async () => {
        const marker = uniqueMarker();
        const pid = spawnFakeSupervisor(marker, "() => {}");
        await until(() => foreignSupervisors(marker).orphaned.includes(pid));

        const result = await reapOrphanedSupervisors(marker, 500);

        expect(result.survivors).toEqual([]);
        expect(pidAlive(pid)).toBe(false);
    });

    test("leaves processes outside the pattern alone", async () => {
        const bystanderMarker = uniqueMarker();
        const reapMarker = uniqueMarker();
        const bystander = spawnFakeSupervisor(bystanderMarker);
        await until(() => foreignSupervisors(bystanderMarker).orphaned.includes(bystander));

        const result = await reapOrphanedSupervisors(reapMarker, 1_000);

        expect(result).toEqual({ attached: [], reaped: [], survivors: [] });
        expect(pidAlive(bystander)).toBe(true);
    });
});

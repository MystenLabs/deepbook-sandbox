// Single-command stack lifecycle (DBSF-022): `pnpm deploy-all` / `pnpm down`.
//
// `devstack up` has no detach mode — it boots the stack and stays attached,
// and its process hosts the dashboard GraphQL API (the `fund` mutation), so it
// must outlive this script. `up` therefore spawns `pnpm stack:up` into its own
// process group (PID + logs in .devstack-supervisor.*), waits until the
// funding strategies answer on the dashboard GraphQL, then brings up the
// compose remnant. `down` reverses it: compose down -v (fork resets require a
// Postgres wipe — watermarks ignore --first-checkpoint), SIGINT to the
// supervisor's process group, then `devstack wipe`.
//
// An attached `pnpm stack:up` in another terminal still works: `up` detects a
// live supervisor and skips the spawn; `down` refuses to wipe under a
// terminal-attached supervisor it doesn't own and says how to finish the
// teardown. A foreign supervisor with NO terminal (an orphaned background
// process — nothing to Ctrl-C) is stopped automatically instead.

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const SANDBOX_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STACK = process.env.SANDBOX_STACK ?? "deepbook-sandbox";
const DASHBOARD_PORT = 9810;
const DASHBOARD_HOST = `api.${STACK}.devstack-plugins.localhost`;
const PID_FILE = resolve(SANDBOX_DIR, ".devstack-supervisor.pid");
const LOG_FILE = resolve(SANDBOX_DIR, ".devstack-supervisor.log");
const READY_TIMEOUT_MS = 480_000;
const POLL_MS = 3_000;
const STOP_TIMEOUT_MS = 90_000;

const log = (msg: string) => console.log(`${pc.cyan("[stack]")} ${msg}`);
const fail = (msg: string): never => {
    console.error(`${pc.red("[stack]")} ${msg}`);
    process.exit(1);
};

/** Is the devstack supervisor serving the dashboard API? The router container
 *  owns the port permanently, so only a routed GraphQL answer (not a mere TCP
 *  accept) proves the supervisor process is alive. Funding strategies register
 *  at the end of boot, so a non-empty fundableCoins doubles as fund-readiness. */
const supervisorReady = (): Promise<boolean> =>
    new Promise((done) => {
        const req = request(
            {
                host: "127.0.0.1",
                port: DASHBOARD_PORT,
                path: "/graphql",
                method: "POST",
                headers: { Host: DASHBOARD_HOST, "Content-Type": "application/json" },
                timeout: 5_000,
            },
            (res) => {
                let body = "";
                res.on("data", (c) => (body += c));
                res.on("end", () => {
                    try {
                        const coins = JSON.parse(body)?.data?.fundableCoins;
                        done(Array.isArray(coins) && coins.length > 0);
                    } catch {
                        done(false);
                    }
                });
            },
        );
        req.on("error", () => done(false));
        req.on("timeout", () => {
            req.destroy();
            done(false);
        });
        req.end(JSON.stringify({ query: "{ fundableCoins { symbol } }" }));
    });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const ownPid = (): number | null => {
    if (!existsSync(PID_FILE)) return null;
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
    // Pids recycle (the file survives crashes and reboots) — only a process
    // that is still our `pnpm stack:up` spawn may be group-signalled.
    const cmd =
        spawnSync("ps", ["-o", "command=", "-p", `${pid}`], { encoding: "utf8" }).stdout ?? "";
    return cmd.includes("stack:up") ? pid : null;
};

/** Signal the supervisor's whole process group; fall back to the single pid if
 *  it isn't a group leader (recycled-pid edge — kill(-pid) throws ESRCH). */
const killGroup = (pid: number, sig: NodeJS.Signals) => {
    try {
        process.kill(-pid, sig);
    } catch {
        try {
            process.kill(pid, sig);
        } catch {
            // already gone
        }
    }
};

const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: SANDBOX_DIR, stdio: "inherit" });
    if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${r.status ?? "signal"}`);
};

/** Foreign `devstack up` supervisors, split by whether a terminal owns them.
 *  Orphans (tty `??`: a dead session's background process) have no Ctrl-C to
 *  press, so `down` stops them itself; attached ones stay the user's call. */
const foreignSupervisors = (): { attached: number[]; orphaned: number[] } => {
    const found: { attached: number[]; orphaned: number[] } = { attached: [], orphaned: [] };
    const pgrep = spawnSync("pgrep", ["-f", "devstack up"], { encoding: "utf8" });
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

const logTail = () => {
    if (!existsSync(LOG_FILE)) return;
    console.error(pc.dim(`--- tail ${LOG_FILE} ---`));
    console.error(readFileSync(LOG_FILE, "utf8").split("\n").slice(-25).join("\n"));
};

async function up(): Promise<void> {
    if (await supervisorReady()) {
        log("devstack supervisor already running — skipping boot");
        // A stale PID file next to a foreign supervisor would send `down` down
        // the owned-kill path against the wrong process — drop it now.
        if (existsSync(PID_FILE) && ownPid() === null) rmSync(PID_FILE, { force: true });
    } else {
        log(`booting devstack fork stack (logs: ${LOG_FILE})`);
        const out = openSync(LOG_FILE, "w");
        const child = spawn("pnpm", ["stack:up"], {
            cwd: SANDBOX_DIR,
            detached: true,
            stdio: ["ignore", out, out],
        });
        if (child.pid === undefined) fail("failed to spawn pnpm stack:up");
        writeFileSync(PID_FILE, `${child.pid}\n`);
        child.unref();

        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (!(await supervisorReady())) {
            if (!pidAlive(child.pid)) {
                logTail();
                fail("devstack supervisor exited during boot — see log above");
            }
            if (Date.now() > deadline) {
                logTail();
                fail(`devstack not fund-ready after ${READY_TIMEOUT_MS / 1000}s — see log above`);
            }
            await sleep(POLL_MS);
        }
        log("devstack fund-ready (funding strategies registered)");
    }

    log("starting compose remnant (postgres, indexer, server)");
    run("docker", ["compose", "up", "-d", "--wait"]);
    log(`stack is up — fund via GraphQL on :${DASHBOARD_PORT} (Host: ${DASHBOARD_HOST})`);
    // The server's `pools` table is manual config the indexer never writes —
    // seed it from the manifest so per-pool endpoints resolve (idempotent).
    // The stack above is already fully up, so a seed failure must not read as
    // a stack failure: point at the standalone retry instead.
    log("seeding pools config table from deployments/mainnet-fork.json");
    const seed = spawnSync("pnpm", ["exec", "tsx", "scripts/seed-pools.ts"], {
        cwd: SANDBOX_DIR,
        stdio: "inherit",
    });
    if (seed.status !== 0) {
        fail(
            "pool seeding failed — the stack itself is UP; fix the cause and re-run " +
                "`pnpm exec tsx scripts/seed-pools.ts` (per-pool server endpoints 404 until seeded)",
        );
    }
}

async function down(): Promise<void> {
    log("stopping compose remnant (down -v: fork resets require a Postgres wipe)");
    run("docker", ["compose", "down", "-v"]);

    const pid = ownPid();
    if (pid !== null) {
        log(`stopping devstack supervisor (pid ${pid})`);
        killGroup(pid, "SIGINT");
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (pidAlive(pid)) {
            if (Date.now() > deadline) {
                log("supervisor ignored SIGINT — sending SIGTERM");
                killGroup(pid, "SIGTERM");
                await sleep(2_000);
                break;
            }
            await sleep(1_000);
        }
    } else if (await supervisorReady()) {
        const { attached, orphaned } = foreignSupervisors();
        if (attached.length > 0) {
            fail(
                `an attached devstack supervisor is running (pid ${attached.join(", ")}) — ` +
                    "Ctrl-C it in its terminal, then re-run `pnpm down` for the wipe",
            );
        }
        if (attached.length === 0 && orphaned.length === 0) {
            fail(
                "a devstack supervisor is serving but its process couldn't be identified — " +
                    "find its pid in devstack-plugins/.devstack/port-locks/*.json (holder.pid), " +
                    "stop it, then re-run `pnpm down`",
            );
        }
        if (orphaned.length > 0) {
            log(`stopping orphaned devstack supervisor (pid ${orphaned.join(", ")}, no terminal)`);
            for (const p of orphaned) {
                try {
                    process.kill(p, "SIGINT");
                } catch {
                    // already gone
                }
            }
        }
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (await supervisorReady()) {
            if (Date.now() > deadline) {
                fail(
                    "supervisor still serving after stop attempt — find its pid in " +
                        "devstack-plugins/.devstack/port-locks/*.json (holder.pid), kill it, " +
                        "then re-run `pnpm down`",
                );
            }
            await sleep(1_000);
        }
    }
    rmSync(PID_FILE, { force: true });

    log("wiping devstack stack state");
    run("pnpm", ["stack:wipe", "--yes"]);
    log("stack is down");
}

const mode = process.argv[2];
if (mode === "up") await up();
else if (mode === "down") await down();
else fail("usage: tsx scripts/stack.ts up|down");

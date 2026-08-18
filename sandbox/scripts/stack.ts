// Single-command stack lifecycle: `pnpm deploy-all` / `pnpm down`.
//
// Since SEDEFI-445 (DBSF-032) the stack is a SINGLE orchestrator: postgres,
// the DeepBook indexer, and the DeepBook server are container-backed devstack
// members (devstack-plugins/{postgres,indexer,server}-member.ts, plus the
// pools-seed task member), so there is no compose side-channel left — this
// script is a pure devstack wrapper.
//
// `devstack up` has no detach mode — it boots the stack and stays attached,
// and its process hosts the dashboard GraphQL API (the `fund` mutation), so it
// must outlive this script. `up` therefore spawns `pnpm stack:up` into its own
// process group (PID + logs in .devstack-supervisor.*), waits until the
// funding strategies answer on the dashboard GraphQL, then polls the same API
// (`services` — the supervisor's live member projection) until every member
// settles ready/done. `down` SIGINTs the supervisor's process group, then
// runs `devstack wipe` — which removes the managed containers including
// Postgres, and with it the indexer's committer watermarks (fork resets
// REQUIRE a Postgres wipe: watermarks resume mainnet checkpoint numbering and
// ignore --first-checkpoint).
//
// An attached `pnpm stack:up` in another terminal still works: `up` detects a
// live supervisor and skips the spawn; `down` refuses to wipe under a
// terminal-attached supervisor it doesn't own and says how to finish the
// teardown. A foreign supervisor with NO terminal (an orphaned background
// process — nothing to Ctrl-C) is stopped automatically instead — and that
// check runs even when the supervisor fails the readiness probe: a WEDGED
// supervisor (alive, holding devstack's per-stack lock, but unserving — e.g.
// its router container died) is exactly the one that must be reaped, or both
// `devstack up` and `devstack wipe` die on its lock ("supervisor live",
// exit 40). `up` never kills: it detects the lock holder and points at
// `pnpm down`. Process discovery/teardown lives in ./stack-supervisors.ts.

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

import {
    SUPERVISOR_PATTERN,
    foreignSupervisors,
    pidAlive,
    reapOrphanedSupervisors,
    sleep,
} from "./stack-supervisors";

const SANDBOX_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STACK = process.env.SANDBOX_STACK ?? "deepbook-sandbox";
const DASHBOARD_PORT = 9810;
const DASHBOARD_HOST = `api.${STACK}.devstack-plugins.localhost`;
const PID_FILE = resolve(SANDBOX_DIR, ".devstack-supervisor.pid");
const LOG_FILE = resolve(SANDBOX_DIR, ".devstack-supervisor.log");
/** An env-overridable timeout; a non-numeric override must fail loudly, not
 *  turn every deadline comparison into `x > NaN` (never true — an infinite
 *  loop). */
const timeoutFromEnv = (name: string, defaultMs: number): number => {
    const raw = process.env[name]?.trim();
    if (raw === undefined || raw === "") return defaultMs;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
        console.error(`[stack] ${name} must be a positive number of milliseconds (got "${raw}")`);
        process.exit(1);
    }
    return ms;
};
const READY_TIMEOUT_MS = timeoutFromEnv("STACK_READY_TIMEOUT_MS", 480_000);
// Member settling includes first-time image work (the indexer is a local Rust
// release build; the server image a pull) — a cold cache legitimately takes
// an hour+, and failed members cut the wait short, so default long.
const SETTLE_TIMEOUT_MS = timeoutFromEnv("STACK_SETTLE_TIMEOUT_MS", 5_400_000);
const POLL_MS = 3_000;
const STOP_TIMEOUT_MS = 90_000;

const log = (msg: string) => console.log(`${pc.cyan("[stack]")} ${msg}`);
const fail = (msg: string): never => {
    console.error(`${pc.red("[stack]")} ${msg}`);
    process.exit(1);
};

/** POST one query to the supervisor's routed dashboard GraphQL. Resolves to
 *  the response's `data`, or null on any transport/parse/GraphQL failure —
 *  callers treat null as "supervisor not (yet) serving". */
const gql = (query: string): Promise<Record<string, unknown> | null> =>
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
                        done(JSON.parse(body)?.data ?? null);
                    } catch {
                        done(null);
                    }
                });
            },
        );
        req.on("error", () => done(null));
        req.on("timeout", () => {
            req.destroy();
            done(null);
        });
        req.end(JSON.stringify({ query }));
    });

/** Is the devstack supervisor serving the dashboard API? The router container
 *  owns the port permanently, so only a routed GraphQL answer (not a mere TCP
 *  accept) proves the supervisor process is alive. Funding strategies register
 *  at the end of boot, so a non-empty fundableCoins doubles as fund-readiness. */
const supervisorReady = async (): Promise<boolean> => {
    const data = await gql("{ fundableCoins { symbol } }");
    const coins = (data as { fundableCoins?: unknown } | null)?.fundableCoins;
    return Array.isArray(coins) && coins.length > 0;
};

type MemberRow = {
    key: string;
    status: string;
    phase: string | null;
    lastError: { tag: string } | null;
};

/** The supervisor's LIVE member projection (the `devstack status` CLI only
 *  serves a degraded offline view with empty rows — the dashboard GraphQL is
 *  the one queryable live source once the supervisor is up). `first: 100` is
 *  the relay maxSize; the default page is 20, one config growth spurt away
 *  from silently truncating exactly the newest members. */
const memberRows = async (): Promise<MemberRow[] | null> => {
    const data = await gql(
        "{ services(first: 100) { edges { node { key status phase lastError { tag } } } } }",
    );
    const edges = (data as { services?: { edges?: { node: MemberRow }[] } } | null)?.services
        ?.edges;
    if (!Array.isArray(edges)) return null;
    return edges.map((e) => e.node);
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

const logTail = () => {
    if (!existsSync(LOG_FILE)) return;
    console.error(pc.dim(`--- tail ${LOG_FILE} ---`));
    console.error(readFileSync(LOG_FILE, "utf8").split("\n").slice(-25).join("\n"));
};

/** Block until every member row settles ready/done. Fails fast on a `failed`
 *  row — a dependency-cascade means one broken member fails its dependents in
 *  the same sweep, so the first failed row is the root cause to surface. The
 *  supervisor was answering GraphQL when this is called, so a sustained run
 *  of unanswered polls means it died mid-settle (e.g. a fork abort) — bail
 *  out instead of spinning silently to the deadline. */
const awaitMembersSettled = async (): Promise<void> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    const MAX_CONSECUTIVE_NULLS = 10; // × POLL_MS = 30s of GraphQL silence
    let nullStreak = 0;
    let lastNarration = "";
    let lastNarratedAt = 0;
    for (;;) {
        const rows = await memberRows();
        if (rows === null) {
            nullStreak += 1;
            if (nullStreak >= MAX_CONSECUTIVE_NULLS) {
                logTail();
                fail(
                    "the supervisor stopped answering while members were settling " +
                        "(died mid-boot? see log above) — re-run `pnpm down && pnpm deploy-all`",
                );
            }
        } else {
            nullStreak = 0;
        }
        if (rows !== null && rows.length > 0) {
            const failed = rows.filter((r) => r.status === "failed");
            if (failed.length > 0) {
                logTail();
                fail(
                    "stack member(s) failed: " +
                        failed
                            .map((r) => `${r.key} (${r.lastError?.tag ?? "unknown error"})`)
                            .join(", ") +
                        " — see log above; recover with `pnpm down && pnpm deploy-all`",
                );
            }
            const unsettled = rows.filter((r) => r.status !== "ready" && r.status !== "done");
            if (unsettled.length === 0) return;
            const narration = unsettled.map((r) => `${r.key} (${r.phase ?? r.status})`).join(", ");
            if (narration !== lastNarration || Date.now() - lastNarratedAt > 60_000) {
                log(`waiting on: ${narration}`);
                lastNarration = narration;
                lastNarratedAt = Date.now();
            }
        }
        if (Date.now() > deadline) {
            logTail();
            fail(
                `stack members not settled after ${SETTLE_TIMEOUT_MS / 1000}s — see log above ` +
                    "(a cold indexer image build is a full Rust release build and can exceed an hour; " +
                    "raise STACK_SETTLE_TIMEOUT_MS if that's what this is)",
            );
        }
        await sleep(POLL_MS);
    }
};

async function up(): Promise<void> {
    if (await supervisorReady()) {
        log("devstack supervisor already running — skipping boot");
        // A stale PID file next to a foreign supervisor would send `down` down
        // the owned-kill path against the wrong process — drop it now.
        if (existsSync(PID_FILE) && ownPid() === null) rmSync(PID_FILE, { force: true });
    } else {
        // A supervisor can hold devstack's per-stack lock while failing the
        // readiness probe above (wedged mid-boot, or its router container
        // died) — spawning another would only die on that lock ("supervisor
        // live", exit 40). Detect and say so; killing is `down`'s job, since
        // an attached or legitimately-still-booting supervisor isn't ours to
        // stop from here.
        const { attached, orphaned } = foreignSupervisors(SUPERVISOR_PATTERN);
        const holders = [...attached, ...orphaned];
        if (holders.length > 0) {
            fail(
                `a devstack supervisor is running but not serving (pid ${holders.join(", ")}) — ` +
                    "either it is still booting (give it a minute and re-run) or it is " +
                    "wedged; `pnpm down` stops it and wipes, then re-run `pnpm deploy-all`",
            );
        }
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
            // The dashboard can be serving while boot is doomed (e.g. the fork
            // member failed and cascaded) — fundableCoins would then stay empty
            // until the timeout. Spot failed rows and bail out early instead.
            const rows = await memberRows();
            const failed = rows?.filter((r) => r.status === "failed") ?? [];
            if (failed.length > 0) {
                logTail();
                fail(
                    "stack member(s) failed during boot: " +
                        failed
                            .map((r) => `${r.key} (${r.lastError?.tag ?? "unknown error"})`)
                            .join(", ") +
                        " — see log above",
                );
            }
            if (Date.now() > deadline) {
                logTail();
                fail(`devstack not fund-ready after ${READY_TIMEOUT_MS / 1000}s — see log above`);
            }
            await sleep(POLL_MS);
        }
        log("devstack fund-ready (funding strategies registered)");
    }

    // Container-backed members (postgres, indexer, server, pools-seed) settle
    // on their own devstack dependency edges; pools seeding is the pools-seed
    // task member, so a settled stack is a fully seeded stack.
    await awaitMembersSettled();
    log("all stack members settled");
    log(`stack is up — fund via GraphQL on :${DASHBOARD_PORT} (Host: ${DASHBOARD_HOST})`);
}

async function down(): Promise<void> {
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
    } else {
        // NOT gated on supervisorReady(): a wedged supervisor (alive and
        // holding devstack's per-stack lock, but unserving — e.g. its router
        // container died) fails the GraphQL probe, and the wipe below would
        // then die on its lock ("supervisor live", exit 40). Hunt the
        // processes directly instead.
        const { attached } = foreignSupervisors(SUPERVISOR_PATTERN);
        if (attached.length > 0) {
            fail(
                `an attached devstack supervisor is running (pid ${attached.join(", ")}) — ` +
                    "Ctrl-C it in its terminal, then re-run `pnpm down` for the wipe",
            );
        }
        const { reaped, survivors } = await reapOrphanedSupervisors(
            SUPERVISOR_PATTERN,
            STOP_TIMEOUT_MS,
        );
        if (survivors.length > 0) {
            fail(
                `orphaned devstack supervisor (pid ${survivors.join(", ")}) ignored SIGINT ` +
                    "and SIGTERM — kill it manually, then re-run `pnpm down`",
            );
        }
        if (reaped.length > 0) {
            log(`stopped orphaned devstack supervisor (pid ${reaped.join(", ")}, no terminal)`);
        }
        if (await supervisorReady()) {
            fail(
                "a devstack supervisor is serving but its process couldn't be identified — " +
                    "find its pid in devstack-plugins/.devstack/port-locks/*.json (holder.pid), " +
                    "stop it, then re-run `pnpm down`",
            );
        }
    }
    rmSync(PID_FILE, { force: true });

    // The wipe removes the managed containers (incl. Postgres — the indexer
    // watermark reset that used to be `docker compose down -v`), networks,
    // and the stack's runtime state.
    log("wiping devstack stack state");
    run("pnpm", ["stack:wipe", "--yes"]);
    log("stack is down");
}

const mode = process.argv[2];
if (mode === "up") await up();
else if (mode === "down") await down();
else fail("usage: tsx scripts/stack.ts up|down");

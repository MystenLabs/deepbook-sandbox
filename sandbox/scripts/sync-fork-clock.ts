// Bring the fork's on-chain Clock up to wall time.
//
// The fork clock starts at the FORK_CHECKPOINT pin and NEVER ticks on its own
// (SEDEFI-453) — checkpoints seal with whatever the Clock says, so after any
// quiet stretch new transactions (faucet, trades) are timestamped in the past
// and look stale in the explorer / fall outside the DeepBook server's 24h
// windows. Run this whenever "new" activity looks old:
//
//   pnpm clock:sync
//
// Forward-only (the chain clock cannot go back); a no-op when the clock is
// already at/ahead of wall time.

import { execFileSync } from "node:child_process";

const log = (msg: string) => console.error(`[sync-fork-clock] ${msg}`);

const container = execFileSync(
    "docker",
    ["ps", "--filter", "name=sui-fork", "--format", "{{.Names}}"],
    { encoding: "utf8" },
)
    .split("\n")
    .filter(Boolean)[0];
if (!container) {
    console.error("[sync-fork-clock] ERROR: no running sui-fork container — is the stack up?");
    process.exit(1);
}

const status = JSON.parse(
    execFileSync("docker", ["exec", container, "sui-fork", "status", "--json"], {
        encoding: "utf8",
    }),
) as { timestamp_ms: number; timestamp: string };

const delta = Date.now() - status.timestamp_ms;
if (!Number.isFinite(delta)) {
    console.error(`[sync-fork-clock] ERROR: unexpected status payload: ${JSON.stringify(status)}`);
    process.exit(1);
}
if (delta <= 0) {
    log(`fork clock already at/ahead of wall time (${status.timestamp}) — nothing to do`);
    process.exit(0);
}

log(`fork clock at ${status.timestamp} — advancing ${Math.round(delta / 1000)}s to wall time...`);
execFileSync(
    "docker",
    ["exec", container, "sui-fork", "advance-clock", "--duration-ms", String(delta)],
    {
        stdio: ["ignore", "ignore", "inherit"],
    },
);
const after = JSON.parse(
    execFileSync("docker", ["exec", container, "sui-fork", "status", "--json"], {
        encoding: "utf8",
    }),
) as { timestamp: string };
log(`fork clock now ${after.timestamp}`);

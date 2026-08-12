// Manually (re-)seed the deepbook-server's `pools` config table from the
// DBSF-016 manifest.
//
// Since SEDEFI-445 the boot-time seeding runs INSIDE devstack (the pools-seed
// task member, devstack-plugins/pools-seed.ts) — this script is the
// standalone re-run for a live stack (e.g. after editing the manifest, or if
// the boot-time seed failed). The SQL is shared with the member
// (devstack-plugins/pools-seed-sql.ts) and idempotent (ON CONFLICT DO
// UPDATE); a stack wipe drops the table with the rest of Postgres.
//
// Standalone run: pnpm exec tsx scripts/seed-pools.ts

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPoolsSeedSql, type PoolPin } from "../devstack-plugins/pools-seed-sql.ts";
import { postgresContainer } from "./utils/devstack-containers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "..", "deployments", "mainnet-fork.json");

const pools = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).deepbook.pools as Record<
    string,
    PoolPin
>;
const { sql, count } = buildPoolsSeedSql(pools);

execFileSync(
    "docker",
    [
        "exec",
        "-i",
        postgresContainer(),
        "psql",
        "-U",
        "postgres",
        "-d",
        "deepbook",
        "-v",
        "ON_ERROR_STOP=1",
    ],
    { input: sql, stdio: ["pipe", "inherit", "inherit"] },
);
console.error(`[seed-pools] seeded ${count} pools from ${MANIFEST_PATH}`);

// Boot-time pools seeding as a devstack task member (SEDEFI-445 / DBSF-032) —
// replaces the seed step scripts/stack.ts ran after `docker compose up`.
//
// Sequencing: the `pools` table is created by the indexer's diesel migrations
// at ITS startup, not by Postgres init — so this member depends on both the
// postgres member (a psql target) and the indexer member (migrations under
// way), then still probes for the table before inserting: indexer readiness
// is metrics-up, which doesn't strictly order against migration completion.
//
// The insert is idempotent, so this settles to `done` on every boot;
// scripts/seed-pools.ts stays as the standalone manual re-run.

import { Effect } from "effect";
import { ContainerRuntimeService, Probes, definePlugin } from "@mysten-incubation/devstack";

import { memberError } from "./container-util.ts";
import { mainnetForkDeepbookIds } from "./deepbook-known.ts";
import { buildPoolsSeedSql } from "./pools-seed-sql.ts";
import type { indexerMember } from "./indexer-member.ts";
import type { postgresMember } from "./postgres-member.ts";

const MEMBER = "pools-seed";
const fail = memberError(MEMBER);

/** Migrations run right after the indexer container starts; this only has to
 *  cover the gap between metrics-up and the migration commit. */
const DEFAULT_TABLE_TIMEOUT_MS = 120_000;

export type PoolsSeedOptions = {
    postgres: ReturnType<typeof postgresMember>;
    indexer: ReturnType<typeof indexerMember>;
    manifestPath?: string;
    tableTimeoutMs?: number;
};

export function poolsSeedMember(opts: PoolsSeedOptions) {
    const tableTimeoutMs = opts.tableTimeoutMs ?? DEFAULT_TABLE_TIMEOUT_MS;

    return definePlugin({
        id: MEMBER,
        role: "task",
        section: "action",
        dependsOn: { postgres: opts.postgres, indexer: opts.indexer },
        start: (deps) =>
            Effect.gen(function* () {
                const runtime = yield* ContainerRuntimeService;
                const { user, database, handle } = deps.postgres;
                const psql = (args: readonly string[]) =>
                    runtime.exec(handle, ["psql", "-U", user, "-d", database, ...args]);

                // Wait for the indexer's migrations to have created `pools`.
                yield* Probes.waitForProbe({
                    label: `${MEMBER}:pools-table`,
                    timeoutMs: tableTimeoutMs,
                    intervalMs: 1_000,
                    probe: () =>
                        Effect.gen(function* () {
                            const res = yield* psql([
                                "-tAc",
                                "SELECT 1 FROM information_schema.tables WHERE table_name = 'pools'",
                            ]);
                            if (res.exitCode !== 0) return Probes.exitCodeProbeResult(res);
                            return res.stdout.trim().length > 0
                                ? true
                                : { ready: false, detail: "pools table not created yet" };
                        }),
                }).pipe(
                    Effect.catch((cause) =>
                        Effect.fail(
                            fail(
                                "table-wait",
                                `the pools table did not appear within ${tableTimeoutMs}ms — ` +
                                    "did the indexer's migrations fail? (docker logs the indexer container)",
                                cause,
                            ),
                        ),
                    ),
                );

                const { sql, count } = yield* Effect.try({
                    try: () => buildPoolsSeedSql(mainnetForkDeepbookIds(opts.manifestPath).pools),
                    catch: (cause) =>
                        fail("build-sql", `failed to build the seed SQL: ${String(cause)}`, cause),
                });

                const seeded = yield* psql(["-v", "ON_ERROR_STOP=1", "-c", sql]).pipe(
                    Effect.catch((cause) => Effect.fail(fail("psql", "psql exec failed", cause))),
                );
                if (seeded.exitCode !== 0) {
                    return yield* Effect.fail(
                        fail(
                            "insert",
                            `pools seed insert failed (exit ${seeded.exitCode}): ${seeded.stderr.trim()}`,
                        ),
                    );
                }

                return { seededPools: count };
            }),
    });
}

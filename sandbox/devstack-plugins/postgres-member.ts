// Postgres as a container-backed devstack member (SEDEFI-445 / DBSF-032) —
// replaces the compose remnant's `postgres` service.
//
// Data lives in the container's WRITABLE LAYER, not a volume: PGDATA is
// relocated off the upstream image's `VOLUME /var/lib/postgresql/data` path
// (the same trick as devstack's internal postgres sidecar). That makes the
// DBSF-022 wipe invariant structural: the indexer's committer watermarks
// resume mainnet checkpoint numbering and ignore --first-checkpoint, so a
// fork reset MUST come with a Postgres reset — `devstack wipe` removes the
// container and the data dies with it, with no separate `down -v` to forget.
// A supervisor stop without wipe keeps the stopped container (and its data),
// matching how the fork's own bind-mounted data dir survives restarts.
//
// Credentials stay the compose-era literals (postgres/postgres/deepbook):
// they are sandbox-internal, and host tooling (psql debugging, seed scripts'
// docker-exec fallback) has them memorized.

import { Effect } from "effect";
import {
    ContainerRuntimeService,
    IdentityContext,
    ManagedContainers,
    Probes,
    definePlugin,
    type ContainerRuntime,
    type ContainerHandle,
} from "@mysten-incubation/devstack";

import {
    containerConfigHash,
    forkStackContainerName,
    forkStackNetworkName,
    localOrPullImage,
    memberError,
} from "./container-util.ts";

const MEMBER = "deepbook-postgres";
const fail = memberError(MEMBER);

const DEFAULT_IMAGE = "postgres:16-alpine";
const POSTGRES_PORT = 5432;
const DEFAULT_HOST_PORT = 5432;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
/** In-network DNS alias — keeps the compose-era DSN literal
 *  (`postgresql://…@postgres:5432/deepbook`) working for the sibling
 *  containers. */
const NETWORK_ALIAS = "postgres";

export const POSTGRES_USER = "postgres";
export const POSTGRES_PASSWORD = "postgres";
export const POSTGRES_DB = "deepbook";

export type PostgresMemberOptions = {
    /** image tag (default postgres:16-alpine; env POSTGRES_IMAGE). */
    image?: string;
    /** published host port (default 5432 — compose parity; env POSTGRES_HOST_PORT). */
    hostPort?: number;
    /** Identity of the chain this database indexes (fork rev + checkpoint).
     *  Folded into the container's configHash so changing the fork pin
     *  RECREATES postgres (fresh watermarks) even on a reconcile without a
     *  wipe — the indexer's committer watermarks resume mainnet checkpoint
     *  numbering and would otherwise silently poison a re-pinned fork. */
    chainKey?: string;
    readyTimeoutMs?: number;
};

/** Readiness = `pg_isready` AND a real `SELECT 1`, both over TCP
 *  (`-h 127.0.0.1`), not the exec-default UNIX socket: the official image
 *  boots a TEMPORARY init server with `listen_addresses=''`, which answers
 *  the socket while TCP — what the indexer/server DSNs and host psql actually
 *  use — is still closed. The restart window (SQLSTATE 57P03) is covered by
 *  the query step. */
const awaitPostgresReady = (
    runtime: ContainerRuntime,
    handle: ContainerHandle,
    timeoutMs: number,
): Effect.Effect<void, unknown> =>
    Probes.waitForProbe({
        label: `${MEMBER}:ready`,
        timeoutMs,
        intervalMs: 500,
        probe: () =>
            Effect.gen(function* () {
                const isReady = yield* runtime.exec(handle, [
                    "pg_isready",
                    "-h",
                    "127.0.0.1",
                    "-U",
                    POSTGRES_USER,
                    "-d",
                    POSTGRES_DB,
                ]);
                if (isReady.exitCode !== 0) return Probes.exitCodeProbeResult(isReady);
                const query = yield* runtime.exec(handle, [
                    "psql",
                    "-h",
                    "127.0.0.1",
                    "-U",
                    POSTGRES_USER,
                    "-d",
                    "postgres",
                    "-tAc",
                    "SELECT 1",
                ]);
                return Probes.exitCodeProbeResult(query);
            }),
    }).pipe(
        Effect.catch((cause) =>
            Effect.fail(
                fail("ready-probe", `postgres did not become ready within ${timeoutMs}ms`, cause),
            ),
        ),
    );

export function postgresMember(opts: PostgresMemberOptions = {}) {
    const image = opts.image ?? (process.env.POSTGRES_IMAGE?.trim() || DEFAULT_IMAGE);
    const hostPortRaw = process.env.POSTGRES_HOST_PORT?.trim();
    const hostPort = opts.hostPort ?? (hostPortRaw ? Number(hostPortRaw) : DEFAULT_HOST_PORT);
    const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!Number.isInteger(hostPort) || hostPort <= 0) {
        throw new Error(`postgres-member: invalid POSTGRES_HOST_PORT (got ${hostPortRaw})`);
    }

    return definePlugin({
        id: MEMBER,
        role: "service",
        section: "service",
        start: () =>
            Effect.gen(function* () {
                const runtime = yield* ContainerRuntimeService;
                const identity = yield* IdentityContext;

                const network = forkStackNetworkName(identity);
                yield* runtime
                    .ensureNetwork({ name: network, app: identity.app, stack: identity.stack })
                    .pipe(
                        Effect.catch((cause) =>
                            Effect.fail(
                                fail("network", `failed to ensure network ${network}`, cause),
                            ),
                        ),
                    );

                const imageRef = yield* localOrPullImage(runtime, MEMBER, image);
                const containerName = forkStackContainerName(identity, MEMBER);
                const env = {
                    POSTGRES_USER,
                    POSTGRES_PASSWORD,
                    POSTGRES_DB,
                    // Off the image's VOLUME path — keeps the data in the writable
                    // layer so container removal (devstack wipe) is the data wipe.
                    PGDATA: "/var/lib/postgresql/data-devstack",
                };
                // hostIp pins docker to a single IPv4 binding — without it docker
                // adds an IPv6 twin (`:::<port>`) that fails the runtime's exact
                // port reconciliation (same convention as the sui-fork member).
                const ports = [{ containerPort: POSTGRES_PORT, hostPort, hostIp: "0.0.0.0" }];

                const handle = yield* ManagedContainers.ensureManagedContainer({
                    runtime,
                    labels: {
                        app: identity.app,
                        stack: identity.stack,
                        plugin: MEMBER,
                        role: "db",
                    },
                    spec: {
                        name: containerName,
                        image: imageRef,
                        recreate: "on-config-change",
                        configHash: containerConfigHash({
                            image: imageRef.digest,
                            env,
                            ports,
                            chainKey: opts.chainKey ?? null,
                        }),
                        env,
                        ports,
                        // The server opens up to 3×100 pooled connections and the
                        // fork indexer another 250 — the image's stock
                        // max_connections=100 invites "too many connections" after
                        // reconnect storms (observed when this container bounced).
                        command: ["postgres", "-c", "max_connections=500"],
                        stopGraceSeconds: 20,
                        networkAttach: [{ name: network, aliases: [NETWORK_ALIAS] }],
                    },
                    mapError: (cause) => fail("container-start", "failed to start postgres", cause),
                });

                yield* awaitPostgresReady(runtime, handle, readyTimeoutMs);

                return {
                    containerName,
                    handle,
                    network,
                    alias: NETWORK_ALIAS,
                    port: POSTGRES_PORT,
                    hostPort,
                    user: POSTGRES_USER,
                    password: POSTGRES_PASSWORD,
                    database: POSTGRES_DB,
                    /** DSN for siblings on the shared per-stack network. */
                    dsn: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${NETWORK_ALIAS}:${POSTGRES_PORT}/${POSTGRES_DB}`,
                };
            }),
    });
}

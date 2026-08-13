// DeepBook server (REST API) as a container-backed devstack member
// (SEDEFI-445 / DBSF-032) — replaces the compose remnant's `deepbook-server`.
//
// KNOWN GAP carried over from DBSF-022: the server's live reads (/status,
// /orderbook/:pool, /deep_supply, /fees, /margin_supply and the margin-metrics
// poller) build a JSON-RPC sui client, and sui-fork serves gRPC only — those
// endpoints fail against the fork; Postgres-backed endpoints (/get_pools,
// /ticker, /trades, /ohclv, …) work. The readiness probe hits `/`, which
// (deliberately, matching the compose healthcheck) does not touch RPC.
//
// Image: the pinned published tag by default (matches the submodule rev, and
// the entrypoint lives in the submodule); SERVER_IMAGE overrides the tag,
// SERVER_IMAGE_BUILD=1 builds from the submodule instead (a single-context
// Dockerfile — buildable by devstack, unlike the indexer's, but a cold Rust
// build takes tens of minutes). Note the submodule entry.sh forces
// RUST_LOG=debug regardless of the env we pass.
//
// Host port 9008 stays published and fixed: the vendored dashboard SPA's
// Price/Depth panels fetch it browser-side, and deepbook-known.ts feeds
// devstack's deepbook() member the same http://127.0.0.1:9008 default — the
// router can't carry it (its entrypoint registry is closed, and 9185 is
// already the router's own claim, which is also why metrics publish on 9186).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import {
    ContainerRuntimeService,
    HttpProbes,
    IdentityContext,
    ManagedContainers,
    definePlugin,
    type ContainerRuntime,
    type ImageRef,
    type sui,
} from "@mysten-incubation/devstack";

import {
    HOST_GATEWAY_EXTRA_HOSTS,
    containerConfigHash,
    forkStackContainerName,
    forkStackNetworkName,
    localOrPullImage,
    memberError,
} from "./container-util.ts";
import type { postgresMember } from "./postgres-member.ts";

const MEMBER = "deepbook-server";
const fail = memberError(MEMBER);

const HERE = dirname(fileURLToPath(import.meta.url));
/** The external/deepbook submodule — the server Dockerfile's build context. */
const SUBMODULE_ROOT = resolve(HERE, "..", "..", "external", "deepbook");

/** Published tag matching the external/deepbook submodule pin (46d846e5…). */
const DEFAULT_IMAGE = "mysten/deepbookv3-server:46d846e5eea615e0eac94bd801b3e82adbe5cf01-arm64";
const REST_PORT = 9008;
const METRICS_PORT = 9184;
const DEFAULT_REST_HOST_PORT = 9008;
/** Offset from the indexer's 9184; NOT 9185 — the devstack router pre-claims
 *  that host port. */
const DEFAULT_METRICS_HOST_PORT = 9186;
const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** Build deepbook-server from the submodule (SERVER_IMAGE_BUILD=1) — a
 *  single-context Dockerfile, so devstack's ensureImage handles it directly
 *  (unlike the indexer's). Cold builds are a full Rust release build. */
const buildServerImage = (
    runtime: ContainerRuntime,
    identity: { app: string; stack: string },
): Effect.Effect<ImageRef, unknown> =>
    runtime
        .ensureImage({
            contextPath: SUBMODULE_ROOT,
            dockerfile: "docker/deepbook-server/Dockerfile",
            buildArgs: {
                PROFILE: "release",
                GIT_REVISION: process.env.GIT_REVISION?.trim() || "local",
            },
            fingerprintPaths: ["Cargo.toml", "Cargo.lock", "crates", "docker/deepbook-server"],
            owner: {
                app: identity.app,
                stack: identity.stack,
                plugin: MEMBER,
                role: "server",
            },
        })
        .pipe(
            Effect.catch((cause) =>
                Effect.fail(
                    fail(
                        "image-build",
                        "failed to build deepbook-server from the submodule",
                        cause,
                    ),
                ),
            ),
        );

export type ServerMemberOptions = {
    /** the fork sui member — readiness gate + RPC endpoint source. */
    sui: ReturnType<typeof sui>;
    /** the postgres member — readiness gate + DSN source. */
    postgres: ReturnType<typeof postgresMember>;
    /** DeepBook package ORIGINAL id (env DEEPBOOK_PACKAGE_ID overrides). */
    deepbookPackageId: string;
    /** DEEP coin package id (env DEEP_TOKEN_PACKAGE_ID overrides). */
    deepTokenPackageId: string;
    /** margin package ORIGINAL id (env MARGIN_PACKAGE_ID overrides). */
    marginPackageId: string;
    /** image tag (default the pinned published tag; env SERVER_IMAGE). */
    image?: string;
    restHostPort?: number;
    metricsHostPort?: number;
    readyTimeoutMs?: number;
};

export function serverMember(opts: ServerMemberOptions) {
    const image = opts.image ?? (process.env.SERVER_IMAGE?.trim() || DEFAULT_IMAGE);
    const buildFromSubmodule = process.env.SERVER_IMAGE_BUILD === "1";
    const deepbookPackageId = process.env.DEEPBOOK_PACKAGE_ID?.trim() || opts.deepbookPackageId;
    const deepTokenPackageId = process.env.DEEP_TOKEN_PACKAGE_ID?.trim() || opts.deepTokenPackageId;
    const marginPackageId = process.env.MARGIN_PACKAGE_ID?.trim() || opts.marginPackageId;
    const restHostPort = opts.restHostPort ?? DEFAULT_REST_HOST_PORT;
    const metricsHostPort = opts.metricsHostPort ?? DEFAULT_METRICS_HOST_PORT;
    const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    return definePlugin({
        id: MEMBER,
        role: "service",
        section: "service",
        dependsOn: { sui: opts.sui, postgres: opts.postgres },
        start: (deps) =>
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

                const imageRef = buildFromSubmodule
                    ? yield* buildServerImage(runtime, identity)
                    : yield* localOrPullImage(runtime, MEMBER, image);

                const containerName = forkStackContainerName(identity, MEMBER);
                const env = {
                    DATABASE_URL: deps.postgres.dsn,
                    // Degraded on the fork (JSON-RPC vs gRPC-only) — see header.
                    RPC_URL: deps.sui.hostGateway.rpcUrl,
                    DEEPBOOK_PACKAGE_ID: deepbookPackageId,
                    DEEP_TOKEN_PACKAGE_ID: deepTokenPackageId,
                    // Compose parity: empty on the fork (entry.sh passes it through,
                    // overriding the binary's mainnet default).
                    DEEP_TREASURY_ID: process.env.DEEP_TREASURY_ID?.trim() ?? "",
                    MARGIN_PACKAGE_ID: marginPackageId,
                    // The margin-metrics poller is useless on the fork (its RPC is
                    // JSON-RPC) — entry.sh doesn't pass the flag, so the env wins:
                    // one tick a day instead of every 30s of log noise.
                    MARGIN_POLL_INTERVAL_SECS:
                        process.env.MARGIN_POLL_INTERVAL_SECS?.trim() || "86400",
                    RUST_LOG: process.env.RUST_LOG?.trim() || "info",
                };
                // hostIp: single IPv4 binding — docker's implicit IPv6 twin fails
                // the runtime's exact port reconciliation.
                const ports = [
                    { containerPort: REST_PORT, hostPort: restHostPort, hostIp: "0.0.0.0" },
                    { containerPort: METRICS_PORT, hostPort: metricsHostPort, hostIp: "0.0.0.0" },
                ];

                const handle = yield* ManagedContainers.ensureManagedContainer({
                    runtime,
                    labels: {
                        app: identity.app,
                        stack: identity.stack,
                        plugin: MEMBER,
                        role: "server",
                    },
                    spec: {
                        name: containerName,
                        image: imageRef,
                        recreate: "on-config-change",
                        configHash: containerConfigHash({ image: imageRef.digest, env, ports }),
                        env,
                        ports,
                        stopGraceSeconds: 20,
                        networkAttach: [network],
                        extraHosts: HOST_GATEWAY_EXTRA_HOSTS,
                    },
                    mapError: (cause) =>
                        fail("container-start", "failed to start deepbook-server", cause),
                });

                const url = `http://127.0.0.1:${restHostPort}`;
                yield* HttpProbes.waitForHttpEndpoint({
                    endpoint: `${url}/`,
                    timeoutMs: readyTimeoutMs,
                    intervalMs: 1_000,
                    requestTimeoutMs: 5_000,
                }).pipe(
                    Effect.catch((cause) =>
                        Effect.fail(
                            fail(
                                "ready-probe",
                                `deepbook-server did not answer on ${url} within ${readyTimeoutMs}ms ` +
                                    `(container ${containerName})`,
                                cause,
                            ),
                        ),
                    ),
                );

                return { containerName, handle, url, metricsHostPort };
            }),
    });
}

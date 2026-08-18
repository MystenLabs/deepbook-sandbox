// DeepBook indexer as a container-backed devstack member (SEDEFI-445 /
// DBSF-032) — replaces the compose remnant's `deepbook-indexer` service.
//
// Ingestion is gRPC, not files: sui-fork emits no checkpoint files, so the
// image (sandbox/docker/deepbook-indexer-fork/, submodule source +
// rpc-ingestion.patch) ingests checkpoints from the fork's RPC — see
// scripts/spikes/fork-indexer-checkpoints/SPIKE-NOTES.md. Being a devstack
// member fixes the two hand-maintained couplings the compose file had:
//   - RPC endpoint: `deps.sui.hostGateway.rpcUrl` carries the fork's ACTUAL
//     allocated host port (compose hardcoded the *preferred* 51002, which the
//     port broker may not get), rewritten to host.docker.internal for
//     container reach; extraHosts maps it to the host gateway on native Linux.
//   - FIRST_CHECKPOINT: fed from the same resolveForkCheckpoint() value the
//     fork member boots from (compose duplicated the numeric pin).
//
// The `dependsOn: { sui }` edge is the fork-readiness gate: `start(deps)` is
// not called until the fork member is ready, replacing nothing-stops-you
// compose startup against a half-booted fork.
//
// devstack's ensureImage cannot emit `--build-context`, so the Dockerfile is
// single-context: the REPO ROOT (submodule + patch dir reachable), with
// Dockerfile.dockerignore keeping the upload small and fingerprintPaths
// keeping the cache identity narrow. Cold builds are a full Rust release
// build (tens of minutes) — pre-warm before smoke runs, like the fork image.

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

const MEMBER = "deepbook-indexer";
const fail = memberError(MEMBER);

const HERE = dirname(fileURLToPath(import.meta.url));
/** Single build context covering both the patch dir and the submodule. */
const REPO_ROOT = resolve(HERE, "..", "..");
const DOCKERFILE = "sandbox/docker/deepbook-indexer-fork/Dockerfile";

const METRICS_PORT = 9184;
const DEFAULT_METRICS_HOST_PORT = 9184;
/** Covers first-boot diesel migrations + ingestion warm-up, not the image
 *  build (ensureImage finishes before the container starts). */
const DEFAULT_READY_TIMEOUT_MS = 240_000;

/** Build the fork-indexer image from the repo-root context. The cache
 *  identity (fingerprintPaths) is the patch dir + the submodule's Rust
 *  surface — unrelated repo edits must not retag (and so recreate) a stateful
 *  ingestion container. Keep the list in sync with Dockerfile.dockerignore:
 *  the fingerprint walk has no ignore-file awareness, so the two hand-kept
 *  lists describe the same file set. */
const buildIndexerImage = (
    runtime: ContainerRuntime,
    identity: { app: string; stack: string },
): Effect.Effect<ImageRef, unknown> =>
    runtime
        .ensureImage({
            contextPath: REPO_ROOT,
            dockerfile: DOCKERFILE,
            buildArgs: {
                PROFILE: "release",
                GIT_REVISION: process.env.GIT_REVISION?.trim() || "local",
            },
            fingerprintPaths: [
                "sandbox/docker/deepbook-indexer-fork",
                "external/deepbook/Cargo.toml",
                "external/deepbook/Cargo.lock",
                "external/deepbook/crates",
            ],
            owner: {
                app: identity.app,
                stack: identity.stack,
                plugin: MEMBER,
                role: "indexer",
            },
        })
        .pipe(
            Effect.catch((cause) =>
                Effect.fail(
                    fail(
                        "image-build",
                        `failed to build the fork indexer image (repo-root context, ${DOCKERFILE})`,
                        cause,
                    ),
                ),
            ),
        );

export type IndexerMemberOptions = {
    /** the fork sui member — readiness gate + RPC endpoint source. */
    sui: ReturnType<typeof sui>;
    /** the postgres member — readiness gate + DSN source. */
    postgres: ReturnType<typeof postgresMember>;
    /** fork checkpoint pin (resolveForkCheckpoint value). undefined = tip
     *  ("latest") — the entrypoint then skips --first-checkpoint. */
    firstCheckpoint?: number;
    /** DeepBook package ORIGINAL id (event type tags carry it; env
     *  DEEPBOOK_PACKAGE_ID overrides). */
    deepbookPackageId: string;
    /** comma-separated margin packages (default none; env MARGIN_PACKAGES). */
    marginPackages?: string;
    /** prebuilt image tag — skips the local build (env INDEXER_IMAGE). */
    image?: string;
    metricsHostPort?: number;
    readyTimeoutMs?: number;
};

export function indexerMember(opts: IndexerMemberOptions) {
    const pulledImage = opts.image ?? process.env.INDEXER_IMAGE?.trim();
    const deepbookPackageId = process.env.DEEPBOOK_PACKAGE_ID?.trim() || opts.deepbookPackageId;
    const marginPackages = process.env.MARGIN_PACKAGES?.trim() || opts.marginPackages || "";
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

                const imageRef = pulledImage
                    ? yield* localOrPullImage(runtime, MEMBER, pulledImage)
                    : yield* buildIndexerImage(runtime, identity);

                const containerName = forkStackContainerName(identity, MEMBER);
                // The fork publishes a host port and joins no plugin network, so
                // siblings dial it through the host gateway (the same pattern as
                // devstack's seal/walrus members). hostGateway.rpcUrl already
                // carries the ACTUAL brokered port.
                const rpcApiUrl = deps.sui.hostGateway.rpcUrl;
                const env = {
                    DATABASE_URL: deps.postgres.dsn,
                    RPC_API_URL: rpcApiUrl,
                    // entry-fork.sh skips non-numeric values (FORK_CHECKPOINT=latest).
                    FIRST_CHECKPOINT:
                        opts.firstCheckpoint !== undefined
                            ? String(opts.firstCheckpoint)
                            : "latest",
                    DEEPBOOK_PACKAGE_ID: deepbookPackageId,
                    MARGIN_PACKAGES: marginPackages,
                    RUST_LOG: process.env.RUST_LOG?.trim() || "info",
                };
                // hostIp: single IPv4 binding — docker's implicit IPv6 twin fails
                // the runtime's exact port reconciliation.
                const ports = [
                    { containerPort: METRICS_PORT, hostPort: metricsHostPort, hostIp: "0.0.0.0" },
                ];

                const handle = yield* ManagedContainers.ensureManagedContainer({
                    runtime,
                    labels: {
                        app: identity.app,
                        stack: identity.stack,
                        plugin: MEMBER,
                        role: "indexer",
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
                        fail("container-start", "failed to start the indexer", cause),
                });

                const metricsUrl = `http://127.0.0.1:${metricsHostPort}/metrics`;
                yield* HttpProbes.waitForHttpEndpoint({
                    endpoint: metricsUrl,
                    timeoutMs: readyTimeoutMs,
                    intervalMs: 2_000,
                    requestTimeoutMs: 5_000,
                }).pipe(
                    Effect.catch((cause) =>
                        Effect.fail(
                            fail(
                                "ready-probe",
                                `indexer metrics did not answer on ${metricsUrl} within ${readyTimeoutMs}ms ` +
                                    `(container ${containerName} — docker logs it for store/migration errors)`,
                                cause,
                            ),
                        ),
                    ),
                );

                return { containerName, handle, metricsUrl, rpcApiUrl };
            }),
    });
}

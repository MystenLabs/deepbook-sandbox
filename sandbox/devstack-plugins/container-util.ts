// Shared helpers for the container-backed fork-stack members (SEDEFI-445 /
// DBSF-032): postgres-member.ts, indexer-member.ts, server-member.ts.
//
// devstack 0.7.0 has no public container-member factory — hostService runs a
// HOST process — so those members are definePlugin plugins over the exported
// plugin-author surface (ContainerRuntimeService + ManagedContainers +
// Probes/HttpProbes), the same substrate devstack's own seal/walrus/postgres
// containers use. The helpers here are the bits all three share.

import { createHash } from "node:crypto";

import { Data, Effect } from "effect";
import {
    ManagedContainers,
    type ContainerRuntime,
    type ImageRef,
} from "@mysten-incubation/devstack";

/** Boot/config failure for a fork-stack container member. The tagged shape
 *  keeps the supervisor's lastErrorTag column meaningful. */
export class ForkStackMemberError extends Data.TaggedError("ForkStackMemberError")<{
    readonly member: string;
    readonly op: string;
    readonly message: string;
    readonly cause?: unknown;
}> {}

export const memberError =
    (member: string) =>
    (op: string, message: string, cause?: unknown): ForkStackMemberError =>
        new ForkStackMemberError({
            member,
            op,
            message,
            ...(cause !== undefined ? { cause } : {}),
        });

/** The per-stack network the three fork-stack containers share (successor of
 *  the compose file's `deepbook-net`). Each member ensureNetwork()s it —
 *  idempotent — so boot order between them doesn't matter. It carries the
 *  devstack managed labels, so `devstack wipe` reaps it. */
export const forkStackNetworkName = (identity: { app: string; stack: string }): string =>
    ManagedContainers.sanitizeAlias(`devstack-${identity.app}-${identity.stack}-deepbook-net`);

/** Compose-style container names: `devstack-<app>-<stack>-<member>` (the same
 *  convention as devstack's own sui-fork container). Deterministic so host
 *  tooling (scripts/seed-pools.ts fallback, docker logs) can find them, but
 *  scripts should prefer the devstack.plugin label filter. */
export const forkStackContainerName = (
    identity: { app: string; stack: string },
    member: string,
): string =>
    ManagedContainers.sanitizeAlias(`devstack-${identity.app}-${identity.stack}-${member}`);

/** `host.docker.internal` → host-gateway /etc/hosts injection, so a container
 *  on our per-stack network can reach the fork's host-published RPC port on
 *  native Linux too. (devstack's HOST_GATEWAY_EXTRA_HOSTS is not exported —
 *  the literal is the documented stable contract.) */
export const HOST_GATEWAY_EXTRA_HOSTS: Readonly<Record<string, string>> = {
    "host.docker.internal": "host-gateway",
};

/** Caller-owned config fingerprint for `recreate: 'on-config-change'`: the
 *  runtime can't infer env/port drift for us, so hash everything that should
 *  force a container replacement when it changes. */
export const containerConfigHash = (config: unknown): string =>
    createHash("sha256").update(JSON.stringify(config)).digest("hex");

/** Resolve an image tag the way compose's `image:` did: use the local image
 *  when present, otherwise pull. (runtime.pullImage alone would fail offline
 *  even when the tag is already on-host — `docker pull` always dials the
 *  registry.) Goes through the runtime adapter, so a configured docker host
 *  is honored. */
export const localOrPullImage = (
    runtime: ContainerRuntime,
    member: string,
    tag: string,
): Effect.Effect<ImageRef, ForkStackMemberError> =>
    Effect.gen(function* () {
        const localId = yield* runtime
            .inspectImageDigest(tag)
            .pipe(Effect.catch(() => Effect.succeed(null)));
        if (localId !== null) return { digest: localId, tag };
        const pull = runtime.pullImage;
        if (pull === undefined) {
            return yield* Effect.fail(
                memberError(member)(
                    "image-pull",
                    `image ${tag} is not on-host and this container runtime has no pull support`,
                ),
            );
        }
        return yield* pull(tag).pipe(
            Effect.catch((cause) =>
                Effect.fail(memberError(member)("image-pull", `failed to pull ${tag}`, cause)),
            ),
        );
    });

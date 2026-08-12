// Locate the stack's devstack-managed containers from host scripts.
//
// Container NAMES are devstack-derived (`devstack-<app>-<stack>-<member>`) —
// deterministic but an implementation detail; the devstack.* labels are the
// lookup contract (the same tuple `devstack wipe`/prune sweep by). Since
// SEDEFI-445 the postgres/indexer/server containers are devstack members, so
// the compose-era fixed names (deepbook-postgres, …) no longer exist.

import { execFileSync } from "node:child_process";

export const SANDBOX_STACK = process.env.SANDBOX_STACK ?? "deepbook-sandbox";

/** First running container carrying the member's devstack label pair, or null. */
export const devstackContainer = (plugin: string, stack = SANDBOX_STACK): string | null => {
    const names = execFileSync(
        "docker",
        [
            "ps",
            "--filter",
            `label=devstack.plugin=${plugin}`,
            "--filter",
            `label=devstack.stack=${stack}`,
            "--format",
            "{{.Names}}",
        ],
        { encoding: "utf8" },
    )
        .split("\n")
        .filter(Boolean);
    return names[0] ?? null;
};

/** The stack's postgres member container; throws when the stack isn't up. */
export const postgresContainer = (stack = SANDBOX_STACK): string => {
    const name = devstackContainer("deepbook-postgres", stack);
    if (name === null) {
        throw new Error(
            `no running postgres container for stack '${stack}' ` +
                "(label devstack.plugin=deepbook-postgres) — is the stack up (pnpm deploy-all)?",
        );
    }
    return name;
};

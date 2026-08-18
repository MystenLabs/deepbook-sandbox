#!/bin/bash
# Entrypoint for the fork-stack indexer: env → CLI args, RPC ingestion only.
# Fork counterpart of external/deepbook/docker/deepbook-sandbox/entry.sh —
# RPC_API_URL replaces LOCAL_CHECKPOINTS_DIR (sui-fork emits no checkpoint
# files; gRPC is the only ingestion source, see the checkpoint-compat spike).

set -euo pipefail

export RUST_BACKTRACE=1
export RUST_LOG=${RUST_LOG:-info}

if [ -z "${DEEPBOOK_PACKAGE_ID:-}" ]; then
    echo "ERROR: DEEPBOOK_PACKAGE_ID is required" >&2
    exit 1
fi
if [ -z "${RPC_API_URL:-}" ]; then
    echo "ERROR: RPC_API_URL is required (the fork's gRPC endpoint)" >&2
    exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL is required" >&2
    exit 1
fi

args=(--database-url "$DATABASE_URL" --db-connection-pool-size 250)
# FIRST_CHECKPOINT is fed from FORK_CHECKPOINT, whose grammar also allows
# "latest" (fork the tip) — not a valid --first-checkpoint value. Skip the
# flag for anything non-numeric; the framework then falls back to its own
# default start (pipeline watermarks on a resumed DB).
case "${FIRST_CHECKPOINT:-}" in
    '' | *[!0-9]*)
        if [ -n "${FIRST_CHECKPOINT:-}" ]; then
            echo "WARN: FIRST_CHECKPOINT='$FIRST_CHECKPOINT' is not numeric — starting from the chain tip" >&2
        fi
        ;;
    *)
        args+=(--first-checkpoint "$FIRST_CHECKPOINT")
        ;;
esac

args+=(sandbox --env localnet --deepbook-package-id "$DEEPBOOK_PACKAGE_ID")
if [ -n "${MARGIN_PACKAGES:-}" ]; then
    args+=(--margin-packages "$MARGIN_PACKAGES")
fi
args+=(--rpc-api-url "$RPC_API_URL")

exec /opt/mysten/bin/deepbook-indexer "${args[@]}"

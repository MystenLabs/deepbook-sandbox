#!/bin/bash

export RUST_BACKTRACE=1
export RUST_LOG=${RUST_LOG:-info}

# Force local checkpoint ingestion for localnet
# This env var is checked in main.rs to use local_ingestion_path instead of remote_store_url
export LOCAL_CHECKPOINTS_DIR=${LOCAL_CHECKPOINTS_DIR:-/checkpoints}

# Build command arguments
# --env testnet is used as a placeholder since DeepbookEnv requires a valid variant.
# The actual checkpoint source between testnet/localnet is determined by CHECKPOINTS_DIR env var in main.rs.
args=(--database-url "$DATABASE_URL" --env testnet --db-connection-pool-size 250)
if [ -n "$FIRST_CHECKPOINT" ]; then
    args+=(--first-checkpoint "$FIRST_CHECKPOINT")
fi

exec /opt/mysten/bin/deepbook-indexer "${args[@]}"

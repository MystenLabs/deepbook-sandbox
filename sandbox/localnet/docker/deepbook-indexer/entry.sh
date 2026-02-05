#!/bin/bash

export RUST_BACKTRACE=1
export RUST_LOG=${RUST_LOG:-info}

# Build command arguments
# testnet is hardcorded here because it will be always be used as is.
# Inside the localnet indexer source code the testnet checkpoints have been replaced
# with localnet checkpoints. So testnet in this case is just a placeholder for a 
# stable ad-hoc flow executed in the indexer's source code.
args=(--database-url "$DATABASE_URL" --env testnet --db-connection-pool-size 250)
if [ -n "$FIRST_CHECKPOINT" ]; then
    args+=(--first-checkpoint "$FIRST_CHECKPOINT")
fi

exec /opt/mysten/bin/deepbook-indexer "${args[@]}"

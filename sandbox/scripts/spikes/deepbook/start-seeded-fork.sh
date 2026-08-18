#!/usr/bin/env bash
# Start a sui-fork mainnet fork pre-seeded with the DeepBook Registry.
#
# The `--object` seeds below are REQUIRED. Without them, sui-fork serves the
# shared DeepBook `Registry` at a stale (genesis) version during execution, and
# `create_pool_admin` either PANICS the fork ("read_child_object does not yet
# support bounded reads" -> h2 stream reset) or runs against stale registry
# state (empty pools, allowed_versions={1}, wrong cap owner). Seeding
# materializes the registry objects at the current checkpoint so the fork
# reflects real mainnet state. Full analysis: ./SUI-FORK-BUG.md / ./README.md.
#
# Usage:
#   ./start-seeded-fork.sh                              # mainnet, default data-dir, :9000
#   RPC_ADDR=127.0.0.1:9001 DATA_DIR=/tmp/fork2 ./start-seeded-fork.sh
#   ./start-seeded-fork.sh --checkpoint 285760000       # extra flags are forwarded to sui-fork
#
# Env overrides:
#   SUI_FORK_BIN  path to the sui-fork binary           (default: `sui-fork` on PATH)
#   NETWORK       fork source network                   (default: mainnet)
#   DATA_DIR      fork data directory                   (default: /tmp/sui-fork-deepbook-spike)
#   RPC_ADDR      RPC bind address                      (default: 127.0.0.1:9000)
#   SEED_OBJECTS  space-separated object ids to seed    (default: the DeepBook
#                 Registry shell + its Versioned UID + the RegistryInner field)

set -euo pipefail

SUI_FORK_BIN="${SUI_FORK_BIN:-sui-fork}"
NETWORK="${NETWORK:-mainnet}"
DATA_DIR="${DATA_DIR:-/tmp/sui-fork-deepbook-spike}"
RPC_ADDR="${RPC_ADDR:-127.0.0.1:9000}"

# DeepBook Registry objects that MUST be materialized at the current checkpoint:
#   Registry (shared)              0xaf16199a...549d
#   Registry.inner Versioned UID   0x4cc3af2f...6de7
#   RegistryInner dynamic field    0x0248830b...06a7
SEED_OBJECTS="${SEED_OBJECTS:-\
0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d \
0x4cc3af2ff1f4b5d41526a0a2cc24723b46e1236a216b24de022b1bf355bb01c2 \
0x0248830b9f259b94f7e9d89c9d4cf8e0af4f78e1ced3a2d7256d8c40f36d06a7}"

if ! command -v "$SUI_FORK_BIN" >/dev/null 2>&1; then
  echo "error: sui-fork binary not found ('$SUI_FORK_BIN'). Put it on PATH or set SUI_FORK_BIN." >&2
  exit 1
fi

object_flags=()
for id in $SEED_OBJECTS; do
  object_flags+=(--object "$id")
done

echo "Starting seeded sui-fork:"
echo "  network : $NETWORK"
echo "  data-dir: $DATA_DIR"
echo "  rpc-addr: $RPC_ADDR"
echo "  seeds   : $SEED_OBJECTS"
echo
echo "Next, in another terminal (use the same monorepo build of the sui CLI):"
echo "  sui client new-env --alias local-fork --rpc http://${RPC_ADDR} && sui client switch --env local-fork"
echo

exec "$SUI_FORK_BIN" start \
  --network "$NETWORK" \
  --data-dir "$DATA_DIR" \
  --rpc-addr "$RPC_ADDR" \
  "${object_flags[@]}" \
  "$@"

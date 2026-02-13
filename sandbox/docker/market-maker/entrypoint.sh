#!/bin/sh
set -e

DEPLOY_DIR="/app/deployments"
POLL_INTERVAL=5
SETTLE_DELAY=10
FIRST_RUN_FLAG="/tmp/.mm_first_run"

echo "Market Maker container started."

# Only clear stale manifests on the very first container start.
# With FORCE_REGENESIS the chain is wiped on every restart,
# so old manifests reference packages that no longer exist.
# On crash restarts we keep the manifest to allow retry.
if [ ! -f "$FIRST_RUN_FLAG" ]; then
  rm -f "$DEPLOY_DIR"/*.json 2>/dev/null || true
  echo "Cleared stale manifests (first run)."
  touch "$FIRST_RUN_FLAG"
else
  echo "Crash restart detected — keeping existing manifests."
fi

echo "Waiting for deployment manifest in ${DEPLOY_DIR}/ ..."

while true; do
  # Look for any .json file in the deployments directory
  manifest=$(find "$DEPLOY_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | head -n 1)
  if [ -n "$manifest" ]; then
    echo "Found deployment manifest: $manifest"
    break
  fi
  echo "No manifest found yet. Retrying in ${POLL_INTERVAL}s..."
  sleep "$POLL_INTERVAL"
done

# Wait for localnet to settle after deploy-all finishes.
# The deployer's coin objects need time to propagate.
echo "Waiting ${SETTLE_DELAY}s for localnet to settle..."
sleep "$SETTLE_DELAY"

echo "Starting market maker..."
exec pnpm market-maker

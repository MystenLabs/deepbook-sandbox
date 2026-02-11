#!/bin/sh
set -e

DEPLOY_DIR="/app/deployments"
POLL_INTERVAL=5

echo "Market Maker container started."

# Clear stale manifests from previous deployments.
# With FORCE_REGENESIS the chain is wiped on every restart,
# so old manifests reference packages that no longer exist.
rm -f "$DEPLOY_DIR"/*.json 2>/dev/null || true
echo "Cleared stale manifests."

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

echo "Starting market maker..."
exec pnpm market-maker

#!/usr/bin/env bash
# Build the PATCHED sui-fork image locally from a sui-repo checkout, applying the
# `get_coin_info -> Ok(None)` patch (the non-SUI-coin funding workaround; see
# SUI-FORK-NOTES.md). Sources the sui code from a LOCAL clone via `git archive`
# (avoids cloning the giant sui monorepo inside Docker, which is flaky), then
# `docker build`s the patched image. Building to completion here populates
# BuildKit's layer cache, so a subsequent `pnpm test:e2e` reuses the (expensive)
# cargo-build layer instead of recompiling.
#
# Usage:
#   SUI_REPO=/path/to/sui SUI_FORK_REV=<rev> ./build-patched-fork.sh
#
# Defaults: SUI_REPO=../../../../../mystenlabs/sui (sibling checkout),
#           SUI_FORK_REV=16f1402387c7ce0f9310e57610428efec930dbf4
#           (sui main, protocol max 130 — covers mainnet 128, includes #26966;
#           or pass `origin/main`).
#
# After it succeeds: `cd ../../../devstack-plugins && pnpm test:e2e`
# (the fixture defaults FORK_IMAGE_CONTEXT to .fork-patched/images, so the e2e
# build hits the cached layer and boots fast).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUI_REPO="${SUI_REPO:-$HERE/../../../../../mystenlabs/sui}"
SUI_FORK_REV="${SUI_FORK_REV:-16f1402387c7ce0f9310e57610428efec930dbf4}"
SUI_CLI_VERSION="${SUI_CLI_VERSION:-devnet-v1.71.0}"
CTX="$HERE/.fork-patched/images"
TARBALL="$CTX/sui-fork/sui-src.tar"

[ -d "$SUI_REPO/.git" ] || { echo "no sui repo at SUI_REPO=$SUI_REPO" >&2; exit 1; }

echo "==> resolving $SUI_FORK_REV in $SUI_REPO (incremental fetch)"
git -C "$SUI_REPO" fetch --no-tags origin "$SUI_FORK_REV" 2>/dev/null || \
  git -C "$SUI_REPO" fetch --no-tags origin main
RESOLVED="$(git -C "$SUI_REPO" rev-parse "${SUI_FORK_REV}^{commit}" 2>/dev/null || git -C "$SUI_REPO" rev-parse FETCH_HEAD)"
echo "    resolved commit: $RESOLVED"

# Sanity: the patch target + protocol must be right at this rev.
git -C "$SUI_REPO" show "$RESOLVED:crates/sui-fork/src/store.rs" | grep -q 'todo!("not supported yet")' \
  || { echo "WARN: get_coin_info may already be implemented at $RESOLVED — verify the patch sed still applies"; }

echo "==> archiving source tree -> $TARBALL"
git -C "$SUI_REPO" archive --format=tar "$RESOLVED" -o "$TARBALL"
echo "    $(du -h "$TARBALL" | cut -f1)"

echo "==> docker build (cold cargo compile ~20-30 min; cached after)"
( cd "$CTX" && docker build \
    --build-arg "SUI_FORK_REV=$RESOLVED" \
    --build-arg "SUI_CLI_VERSION=$SUI_CLI_VERSION" \
    -f sui-fork/Dockerfile -t "sui-fork-patched:${RESOLVED:0:12}" . )

echo
echo "OK — patched fork image built (sui-fork-patched:${RESOLVED:0:12}) and BuildKit layers cached."
echo "Next: cd $HERE/../../../devstack-plugins && nvm use 24 && pnpm test:e2e"

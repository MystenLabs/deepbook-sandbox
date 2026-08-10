#!/usr/bin/env bash
# Build the sui-fork image from the UPSTREAM fix branch
# `fork-rpc-store-simulate-transaction` (MystenLabs/sui#27520) — the sui-fork
# storage rewrite that embeds the real sui-rpc-store indexer and removes the
# `todo!()` index stubs (the GetCoinInfo abort that blocks DEEP/USDC funding;
# see SUI-FORK-NOTES.md). Unlike build-patched-fork.sh, NO source patch is
# applied — the fix is upstream code.
#
# NOTE (2026-08-04): the branch head (eb46537f) builds fine but ABORTS during
# fork genesis on mainnet forks (see SUI-FORK-NOTES.md "Fork-genesis
# regression") — this script exists to retest the branch as it evolves.
#
# Assembles the build context in .fork-branch/images from the installed
# devstack package's images/ dir, with the Dockerfile swapped for one that
# COPYs a git-archive tarball of a LOCAL sui checkout instead of cloning the
# multi-GB monorepo inside Docker (which is flaky). GIT_REVISION is exported
# during the cargo build because the tarball has no .git and sui's
# bin_version!() macro panics at compile time without either.
#
# Usage:
#   SUI_REPO=/path/to/sui ./build-branch-fork.sh
#
# Defaults: SUI_REPO=../../../../../mystenlabs/sui (sibling checkout),
#           SUI_FORK_REV=origin/fork-rpc-store-simulate-transaction (fetched
#           fresh; pass a sha to pin).
#
# After it succeeds, boot the stack against the image via the BUILD CONTEXT —
# devstack's `image: {pull}` is a bare `docker pull` and can never see a
# locally built tag (see SUI-FORK-NOTES.md), so DEVSTACK_SUI_FORK_IMAGE does
# NOT work for local images:
#   cd ../../../devstack-plugins
#   FORK_IMAGE_CONTEXT="<this dir>/.fork-branch/images" SUI_FORK_REV=<resolved sha> pnpm exec devstack up
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUI_REPO="${SUI_REPO:-$HERE/../../../../../mystenlabs/sui}"
SUI_FORK_BRANCH="${SUI_FORK_BRANCH:-fork-rpc-store-simulate-transaction}"
SUI_FORK_REV="${SUI_FORK_REV:-origin/$SUI_FORK_BRANCH}"
SUI_CLI_VERSION="${SUI_CLI_VERSION:-devnet-v1.71.0}"
DEVSTACK_IMAGES="$HERE/../../../devstack-plugins/node_modules/@mysten-incubation/devstack/images"
CTX="$HERE/.fork-branch/images"
TARBALL="$CTX/sui-fork/sui-src.tar"

[ -d "$SUI_REPO/.git" ] || { echo "no sui repo at SUI_REPO=$SUI_REPO" >&2; exit 1; }
[ -d "$DEVSTACK_IMAGES" ] || { echo "devstack package not installed — pnpm install in sandbox/devstack-plugins first" >&2; exit 1; }

echo "==> fetching $SUI_FORK_BRANCH in $SUI_REPO"
# branch may be deleted upstream after merge — fall back so an explicit
# SUI_FORK_REV=<sha> still resolves
git -C "$SUI_REPO" fetch --no-tags origin "$SUI_FORK_BRANCH" ||
    git -C "$SUI_REPO" fetch --no-tags origin main
RESOLVED="$(git -C "$SUI_REPO" rev-parse "${SUI_FORK_REV}^{commit}")"
echo "    resolved commit: $RESOLVED"

# Sanity: this rev must already contain the fix. Guard the path first — a
# failing `git show` inside the `if` would otherwise pass the check vacuously
# (plausible on a storage-rewrite branch that moves files around).
git -C "$SUI_REPO" cat-file -e "$RESOLVED:crates/sui-fork/src/store.rs" || {
  echo "ERROR: crates/sui-fork/src/store.rs missing at $RESOLVED — the branch moved it; update this check" >&2
  exit 1
}
if git -C "$SUI_REPO" show "$RESOLVED:crates/sui-fork/src/store.rs" | grep -q 'todo!("not supported yet")'; then
  echo "ERROR: store.rs at $RESOLVED still has the todo!(\"not supported yet\") index stubs —" >&2
  echo "       this rev predates the fix; use build-patched-fork.sh instead" >&2
  exit 1
fi

echo "==> assembling context $CTX from installed devstack images/"
rm -rf "$CTX"
mkdir -p "$CTX/sui-fork"
cp -R "$DEVSTACK_IMAGES/_shared" "$CTX/_shared"
cp "$DEVSTACK_IMAGES/sui-fork/entrypoint.sh" "$CTX/sui-fork/entrypoint.sh"

cat >"$CTX/sui-fork/Dockerfile" <<'DOCKERFILE'
FROM rust:1.90-bookworm AS builder

ARG SUI_FORK_REV

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates clang cmake git libclang-dev libpq-dev libssl-dev pkg-config protobuf-compiler \
  && rm -rf /var/lib/apt/lists/*

# Source arrives as a git-archive tarball of SUI_FORK_REV (no .git inside), so
# bin_version!()'s `git describe` cannot run — GIT_REVISION must be exported.
COPY sui-fork/sui-src.tar /src/sui-src.tar
RUN set -eux; \
  test -n "$SUI_FORK_REV"; \
  mkdir -p /src/sui; \
  tar -xf /src/sui-src.tar -C /src/sui; \
  rm /src/sui-src.tar; \
  cd /src/sui; \
  GIT_REVISION="$SUI_FORK_REV" cargo build --release -p sui-fork; \
  strip /src/sui/target/release/sui-fork

FROM ubuntu:24.04

ARG SUI_CLI_VERSION
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gawk git libpq5 libssl3 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  test -n "$SUI_CLI_VERSION"; \
  case "$TARGETARCH" in \
    arm64) SUI_PLATFORM=ubuntu-aarch64 ;; \
    amd64) SUI_PLATFORM=ubuntu-x86_64 ;; \
    *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/MystenLabs/sui/releases/download/${SUI_CLI_VERSION}/sui-${SUI_CLI_VERSION}-${SUI_PLATFORM}.tgz"; \
  curl -fsSL "$url" -o /tmp/sui.tgz; \
  mkdir -p /tmp/sui-unpack; \
  tar -xzf /tmp/sui.tgz -C /tmp/sui-unpack; \
  find /tmp/sui-unpack -maxdepth 2 -type f -executable -exec mv {} /usr/local/bin/ \; ; \
  rm -rf /tmp/sui.tgz /tmp/sui-unpack; \
  sui --version

COPY --from=builder /src/sui/target/release/sui-fork /usr/local/bin/sui-fork
COPY _shared/signal-forward.sh /usr/local/lib/devstack/signal-forward.sh
COPY sui-fork/entrypoint.sh /usr/local/bin/devstack-sui-fork-entrypoint.sh
RUN chmod +x /usr/local/bin/devstack-sui-fork-entrypoint.sh

ENV RUST_LOG=info,sui_fork=info,sui=info

EXPOSE 9000

ENTRYPOINT ["/usr/local/bin/devstack-sui-fork-entrypoint.sh"]
DOCKERFILE

echo "==> archiving source tree -> $TARBALL"
git -C "$SUI_REPO" archive --format=tar "$RESOLVED" -o "$TARBALL"
echo "    $(du -h "$TARBALL" | cut -f1)"

echo "==> docker build (cold cargo compile ~20-30 min; cached after)"
( cd "$CTX" && docker build \
    --build-arg "SUI_FORK_REV=$RESOLVED" \
    --build-arg "SUI_CLI_VERSION=$SUI_CLI_VERSION" \
    -f sui-fork/Dockerfile -t "sui-fork-branch:${RESOLVED:0:12}" . )

echo
echo "OK — branch fork image built: sui-fork-branch:${RESOLVED:0:12}"
echo "Boot the stack with it (build context, NOT DEVSTACK_SUI_FORK_IMAGE — a"
echo "local tag cannot be docker-pulled; the context build cache-hits instead):"
echo "  cd $HERE/../../../devstack-plugins"
echo "  FORK_IMAGE_CONTEXT=\"$CTX\" SUI_FORK_REV=$RESOLVED pnpm exec devstack up"

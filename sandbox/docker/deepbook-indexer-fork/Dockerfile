# DeepBook indexer built for the mainnet-fork stack (DBSF-022).
#
# Mirrors external/deepbook/docker/deepbook-sandbox/Dockerfile but applies
# rpc-ingestion.patch on top of the submodule source: the stock indexer can only
# ingest checkpoints from a local directory or a hardcoded remote store, while
# sui-fork serves checkpoints exclusively over gRPC (see
# scripts/spikes/fork-indexer-checkpoints/SPIKE-NOTES.md). The patch adds
# --rpc-api-url to the sandbox subcommand and caps ingestion concurrency
# (the fork proxies availableRange to upstream mainnet GraphQL per GetCheckpoint;
# uncapped parallel fetches trip its rate limit and stall ingestion).
#
# Build context: the REPO ROOT (single context covering this directory and the
# external/deepbook submodule) — the devstack indexer member builds it via
# ensureImage, which cannot pass `--build-context`, so the former named
# `deepbook-src` context is gone. Dockerfile.dockerignore (BuildKit reads the
# sibling <Dockerfile>.dockerignore) allowlists just the paths COPYed below.
# Standalone build (from the repo root):
#   docker build -f sandbox/docker/deepbook-indexer-fork/Dockerfile .

FROM rust:1.90.0 AS builder

ARG PROFILE=release
ARG GIT_REVISION
ENV GIT_REVISION=$GIT_REVISION

WORKDIR /work

COPY external/deepbook/Cargo.lock external/deepbook/Cargo.toml ./
COPY external/deepbook/crates/ ./crates/
COPY sandbox/docker/deepbook-indexer-fork/rpc-ingestion.patch ./

RUN apt-get update && apt-get install -y build-essential libssl-dev pkg-config curl cmake clang ca-certificates

RUN set -eux; \
    git apply --stat rpc-ingestion.patch; \
    git apply rpc-ingestion.patch; \
    grep -q 'rpc_api_url' crates/indexer/src/main.rs

RUN cargo build --profile $PROFILE --bin deepbook-indexer --config net.git-fetch-with-cli=true

FROM debian:trixie-slim AS runtime

RUN apt-get update && apt-get -y --no-install-recommends install \
    wget curl ca-certificates libpq-dev procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /work/target/release/deepbook-indexer /opt/mysten/bin/
COPY sandbox/docker/deepbook-indexer-fork/entry-fork.sh /entry-fork.sh
RUN chmod +x /opt/mysten/bin/deepbook-indexer /entry-fork.sh

ARG BUILD_DATE
ARG GIT_REVISION
LABEL build-date=$BUILD_DATE
LABEL git-revision=$GIT_REVISION

CMD ["/entry-fork.sh"]

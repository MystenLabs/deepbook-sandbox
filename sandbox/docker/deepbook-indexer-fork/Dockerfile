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
# Build context: this directory (patch + entrypoint). The deepbook submodule
# enters as the named context `deepbook-src`:
#   docker build --build-context deepbook-src=../../../external/deepbook .
# (docker-compose.yml wires this via build.additional_contexts.)

FROM rust:1.90.0 AS builder

ARG PROFILE=release
ARG GIT_REVISION
ENV GIT_REVISION=$GIT_REVISION

WORKDIR /work

COPY --from=deepbook-src Cargo.lock Cargo.toml ./
COPY --from=deepbook-src crates/ ./crates/
COPY rpc-ingestion.patch ./

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
COPY entry-fork.sh /entry-fork.sh
RUN chmod +x /opt/mysten/bin/deepbook-indexer /entry-fork.sh

ARG BUILD_DATE
ARG GIT_REVISION
LABEL build-date=$BUILD_DATE
LABEL git-revision=$GIT_REVISION

CMD ["/entry-fork.sh"]

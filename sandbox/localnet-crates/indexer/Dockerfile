# DeepBook Indexer for Localnet
#
# Builds the localnet-crates indexer which supports dynamic package addresses
# and local checkpoint file ingestion for indexing a local Sui node.
#
# Usage:
#   docker build -f indexer/Dockerfile -t deepbook-indexer-localnet .
#   docker run -e ENV=localnet -e LOCAL_INGESTION_PATH=/checkpoints \
#              -e CORE_PACKAGES=0x... deepbook-indexer-localnet

FROM rust:1.82.0 AS builder

ARG PROFILE=release
ARG GIT_REVISION=local
ENV GIT_REVISION=$GIT_REVISION

WORKDIR /work

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libssl-dev \
    pkg-config \
    curl \
    cmake \
    clang \
    ca-certificates \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:${PATH}"

# Copy the workspace and crates
COPY Cargo.toml Cargo.lock ./
COPY indexer/ ./indexer/
COPY schema/ ./schema/
COPY server/ ./server/

# Build the indexer
RUN cargo build --profile $PROFILE --bin deepbook-indexer --config net.git-fetch-with-cli=true

# Runtime stage
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the binary from builder
COPY --from=builder /work/target/release/deepbook-indexer /opt/deepbook/bin/deepbook-indexer
RUN chmod +x /opt/deepbook/bin/deepbook-indexer

# Create a directory for checkpoints
RUN mkdir -p /checkpoints

ARG BUILD_DATE
ARG GIT_REVISION
LABEL build-date=$BUILD_DATE
LABEL git-revision=$GIT_REVISION

EXPOSE 9184

ENTRYPOINT ["/opt/deepbook/bin/deepbook-indexer"]
CMD ["--help"]

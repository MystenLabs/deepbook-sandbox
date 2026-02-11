FROM node:22-alpine

# Install pnpm and curl (for healthcheck)
RUN corepack enable && corepack prepare pnpm@latest --activate \
    && apk add --no-cache curl

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy application code
COPY tsconfig.json ./
COPY scripts/ scripts/

# Copy entrypoint
COPY docker/market-maker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000 9090

ENTRYPOINT ["/entrypoint.sh"]

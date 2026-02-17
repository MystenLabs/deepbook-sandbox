# Market Maker - Automated market maker for localnet DEEP/SUI pool
FROM node:22-alpine

RUN corepack enable && apk add --no-cache curl

WORKDIR /app

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

# Copy TypeScript config and scripts
COPY tsconfig.json ./
COPY scripts/ scripts/

CMD ["pnpm", "market-maker"]

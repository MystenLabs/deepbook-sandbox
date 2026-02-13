# Oracle Service - Updates Pyth price feeds on localnet
FROM node:22-alpine

RUN corepack enable

WORKDIR /app

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

# Copy TypeScript config and scripts
COPY tsconfig.json ./
COPY scripts/ scripts/

CMD ["pnpm", "oracle-service"]

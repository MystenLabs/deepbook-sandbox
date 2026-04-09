# ---- Builder ----
FROM node:22-alpine AS builder
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

# ---- Runtime ----
FROM node:22-alpine
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod
COPY --from=builder /app/dist/ dist/

EXPOSE 9009
CMD ["node", "dist/index.js"]

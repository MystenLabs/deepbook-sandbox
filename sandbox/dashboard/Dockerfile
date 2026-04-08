# ---- Builder ----
FROM node:22-alpine AS builder
RUN corepack enable

# PRIVATE_KEY is baked into the bundle by Vite (via define) so the dev
# wallet has the deployer key available without a runtime fetch.
ARG PRIVATE_KEY=""
ENV PRIVATE_KEY=$PRIVATE_KEY

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts tailwind.config.ts postcss.config.js ./
COPY index.html ./
COPY public/ public/
COPY src/ src/
RUN pnpm run build

# ---- Runtime ----
FROM nginx:alpine

COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

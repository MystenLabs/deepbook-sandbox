# ---- Builder ----
FROM node:22-alpine AS builder
RUN corepack enable

# Accept build arg for API token
ARG VITE_CONTROL_API_TOKEN
ENV VITE_CONTROL_API_TOKEN=$VITE_CONTROL_API_TOKEN

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

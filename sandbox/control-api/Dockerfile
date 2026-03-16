FROM node:20-alpine

WORKDIR /app

# Install docker CLI and docker-compose for executing docker commands
RUN apk add --no-cache docker-cli docker-compose

# Copy package files
COPY package*.json ./
COPY pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN pnpm build

EXPOSE 9011

CMD ["node", "dist/index.js"]

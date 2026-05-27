# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: builder — installs all deps and compiles TypeScript to dist/
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first, leveraging Docker layer cache.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Bring in sources and build.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies so we ship a minimal node_modules to runtime.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: runtime — minimal image with only what's needed to run the server
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="mcp-cnpg-axians" \
      org.opencontainers.image.description="MCP server for CloudNativePG: cluster lifecycle, backups, declarative DB CRDs, pooler, observability." \
      org.opencontainers.image.source="https://github.com/setra06/mcp-cnpg-axians" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Axians Data Management"

WORKDIR /app

# Copy only runtime artifacts. node_modules already pruned to prod deps.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

# Default transport is stdio. Override with -e TRANSPORT=http and publish a port
# (and set MCP_HTTP_PORT/HOST/TOKEN) to expose the Streamable HTTP transport.
ENV NODE_ENV=production

# Exec form so SIGTERM reaches node directly (clean shutdown for K8s rolling updates).
ENTRYPOINT ["node", "dist/index.js"]

# Dockerfile for @abliteration/mcp
#
# Multi-stage image for the stdio MCP server:
#   1. build - installs full deps (including TypeScript), compiles src/*.ts
#              into dist/ via `tsc`.
#   2. runtime - alpine with production deps only and the compiled output.
#
# The server speaks JSON-RPC on stdin/stdout. Nothing is published on a
# network port; the container is meant to be launched by an MCP host
# (Claude Desktop, Claude Code, Cursor, Windsurf, Glama's checker) and
# attached to its own stdio.
#
# Build:
#   docker build -t abliteration-mcp .
#
# Run (introspection, no API key needed to list tools):
#   docker run --rm -i abliteration-mcp
#
# Run (live calls, pass the key as env):
#   docker run --rm -i -e ABLITERATION_API_KEY=abl_live_... abliteration-mcp

# ---------- stage 1: build ----------
FROM node:20-alpine AS build

WORKDIR /app

# Install full deps first so the layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript into dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- stage 2: runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + the shebang entry point.
COPY --from=build /app/dist ./dist
COPY bin ./bin

# Drop root for the running process.
RUN addgroup -S mcp && adduser -S mcp -G mcp \
    && chown -R mcp:mcp /app
USER mcp

# stdio only - no EXPOSE, no HEALTHCHECK on a port.
CMD ["node", "bin/mcp.mjs"]

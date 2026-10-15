# syntax=docker/dockerfile:1
# Container image for MCP hosts and directories that run servers in Docker.
# On a Mac, prefer running it natively so the token can live in the Keychain.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="starling-mcp" \
      org.opencontainers.image.description="Privacy-first MCP server for the Starling Bank public API" \
      org.opencontainers.image.source="https://github.com/Zesty0wl/starling-mcp" \
      org.opencontainers.image.documentation="https://github.com/Zesty0wl/starling-mcp#readme" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]

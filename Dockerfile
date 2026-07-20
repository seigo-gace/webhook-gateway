# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=build-deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN groupadd --system --gid 10001 appuser \
  && useradd --system --uid 10001 --gid appuser --home-dir /app --shell /usr/sbin/nologin appuser \
  && mkdir -p /app /spool /spool/failed \
  && chown -R appuser:appuser /app /spool

COPY --chown=appuser:appuser package.json package-lock.json ./
COPY --chown=appuser:appuser --from=prod-deps /app/node_modules ./node_modules
COPY --chown=appuser:appuser --from=build /app/dist ./dist
COPY --chown=appuser:appuser config ./config
COPY --chown=appuser:appuser docs ./docs
COPY --chown=appuser:appuser scripts ./scripts

USER appuser
EXPOSE 7373
CMD ["node", "dist/server.js"]

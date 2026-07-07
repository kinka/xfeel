FROM oven/bun:1 AS base
WORKDIR /app

# 依赖层单独缓存
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY examples ./examples

# SQLite 数据、媒体文件都落在 /app/data，挂卷持久化
ENV XFEEL_DB_PATH=/app/data/xfeel.db
VOLUME ["/app/data"]

EXPOSE 3100
CMD ["sh", "-c", "bun run packages/db/src/init.ts && bun run apps/ingest-api/src/server.ts"]

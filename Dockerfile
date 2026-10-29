# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# sqlite3 のネイティブビルドに必要なツール
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

WORKDIR /app

# ffmpeg は /synthesis フォールバック時のトランスコード用
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV TZ=Asia/Tokyo

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node

STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]

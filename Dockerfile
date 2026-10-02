# syntax=docker/dockerfile:1
# 同じイメージをローカルDockerとAWS（ECS Fargate）の両方で使う

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/ai-core/package.json packages/ai-core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build \
 && node scripts/vendor.mjs \
 && node scripts/check-licenses.mjs --production --notices apps/web/public/THIRD_PARTY_NOTICES.txt \
 && npm prune --omit=dev

FROM node:22-alpine
# PDF の日本語表示用フォント（Noto Sans CJK、SIL Open Font License 1.1）
RUN apk add --no-cache font-noto-cjk
ENV NODE_ENV=production \
    PORT=8787 \
    WEB_DIR=/app/apps/web/public \
    MIGRATIONS_DIR=/app/db/migrations \
    STORAGE_DIR=/data/artifacts
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/ai-core/package.json ./packages/ai-core/package.json
COPY --from=build /app/packages/ai-core/dist ./packages/ai-core/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/db ./db
COPY LICENSE* NOTICE* ./
# AWS RDS へ TLS で接続するための公開CAバンドル（ローカルでは未使用）
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/server.js"]

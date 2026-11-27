FROM node:24-slim AS builder
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts

COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./
COPY backend/tsconfig.json backend/tsconfig.build.json backend/nest-cli.json ./
COPY backend/src ./src

RUN npx prisma generate && npm run build

FROM node:24-slim AS migrator
WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/src/env.ts ./src/env.ts

USER node
CMD ["npx", "--no-install", "prisma", "migrate", "deploy"]

FROM node:24-slim AS prod-deps
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN mkdir -p /data/uploads && chown node:node /data/uploads && chmod 0700 /data/uploads

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

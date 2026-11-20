FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY backend/package*.json ./
COPY backend/prisma ./prisma/

RUN npm ci || npm install
RUN npx prisma generate

COPY backend/tsconfig*.json backend/nest-cli.json ./
COPY backend/src ./src

RUN npm run build

FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY backend/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY backend/assets ./assets
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
COPY ghost-app ./ghost-app

RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]

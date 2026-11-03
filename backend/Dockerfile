# Multi-stage Dockerfile para Backend Core (NestJS)
# Etapa 1: Construcción y generación de Prisma Client
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

# Copia de manifiestos de dependencias
COPY package*.json ./
COPY prisma ./prisma/

# Instalación de todas las dependencias y generación de Prisma
RUN npm ci || npm install
RUN npx prisma generate

# Copia de código fuente y compilación TypeScript
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build

# Etapa 2: Imagen final de producción optimizada
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Copia de dependencias de producción y cliente Prisma generado
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Asignar permisos al usuario no privilegiado y cambiar de usuario
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]

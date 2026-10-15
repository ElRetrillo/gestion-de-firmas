# Multi-stage Dockerfile para Backend Core (NestJS)
# Etapa 1: Construcción y generación de Prisma Client
FROM node:20-alpine AS builder

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

# Asignar permisos al usuario no privilegiado y cambiar de usuario
RUN chown -R node:node /app
USER node

EXPOSE 3001

CMD ["node", "dist/main.js"]

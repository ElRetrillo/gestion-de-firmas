#!/bin/sh
set -e

echo "[Entrypoint] Sincronizando esquema de base de datos con Prisma..."
npx prisma db push --skip-generate --accept-data-loss

echo "[Entrypoint] Iniciando servidor Backend Core..."
exec node dist/main.js

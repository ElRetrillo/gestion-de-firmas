#!/bin/bash
# Respaldo automatizado diario de PostgreSQL con retención rotativa de 14 días
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${APP_DIR}/backups/postgres"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando respaldo PostgreSQL..."

POSTGRES_CONTAINER="gestion-firmas-postgres"
BACKUP_SQL_FILE="${BACKUP_DIR}/db_gestion_firmas_${TIMESTAMP}.sql.gz"

if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    docker exec -t "${POSTGRES_CONTAINER}" pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-gestion_firmas}" | gzip -9 > "${BACKUP_SQL_FILE}"
    echo "   Respaldo generado: ${BACKUP_SQL_FILE}"
else
    echo "   [ERROR] Contenedor ${POSTGRES_CONTAINER} no encontrado o inactivo." >&2
    exit 1
fi

find "${BACKUP_DIR}" -type f -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Respaldo completado."

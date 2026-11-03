#!/bin/bash
# ==============================================================================
# SCRIPT DE COPIA DE SEGURIDAD AUTOMATIZADA (BACKUP CRON)
# Sistema de Gestión de Firmas y Telemetría - I. Municipalidad de Coquimbo
# Cumplimiento: Ley N° 21.663 (ANCI) e ISO/IEC 27001 (Respaldo y Continuidad)
# ==============================================================================
set -e

# Configuración de Rutas y Retención
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${APP_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RETENTION_DAYS=14 # Retención rotativa de 14 días

mkdir -p "${BACKUP_DIR}/postgres"
mkdir -p "${BACKUP_DIR}/minio"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando respaldo institucional..."

# 1. Respaldo Criptográfico de Base de Datos PostgreSQL
echo "-> Exportando PostgreSQL (schema y ledger de firmas)..."
POSTGRES_CONTAINER="gestion-firmas-postgres"
BACKUP_SQL_FILE="${BACKUP_DIR}/postgres/db_gestion_firmas_${TIMESTAMP}.sql.gz"

if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    docker exec -t "${POSTGRES_CONTAINER}" pg_dump -U postgres gestion_firmas | gzip -9 > "${BACKUP_SQL_FILE}"
    echo "   PostgreSQL respaldado exitosamente en: ${BACKUP_SQL_FILE}"
else
    echo "   [ERROR] Contenedor ${POSTGRES_CONTAINER} no encontrado o inactivo." >&2
fi

# 2. Respaldo de Almacenamiento de Evidencias (Volumen MinIO)
echo "-> Respaldando evidencias y PDFs firmados de MinIO..."
MINIO_CONTAINER="gestion-firmas-minio"
BACKUP_MINIO_FILE="${BACKUP_DIR}/minio/minio_data_${TIMESTAMP}.tar.gz"

if docker ps --format '{{.Names}}' | grep -q "^${MINIO_CONTAINER}$"; then
    # Respaldo directo de los datos usando docker cp o tar
    docker run --rm \
      --volumes-from "${MINIO_CONTAINER}" \
      -v "${BACKUP_DIR}/minio:/backup_dest" \
      alpine tar czf "/backup_dest/minio_data_${TIMESTAMP}.tar.gz" -C /data .
    echo "   Evidencias MinIO respaldadas exitosamente en: ${BACKUP_MINIO_FILE}"
else
    echo "   [ERROR] Contenedor ${MINIO_CONTAINER} no encontrado o inactivo." >&2
fi

# 3. Purga Automática de Respaldos Antiguos (> RETENTION_DAYS días)
echo "-> Aplicando política de rotación y purga de respaldos (> ${RETENTION_DAYS} días)..."
find "${BACKUP_DIR}/postgres" -type f -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete
find "${BACKUP_DIR}/minio" -type f -name "*.tar.gz" -mtime +${RETENTION_DAYS} -delete

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Proceso de respaldo completado con éxito."

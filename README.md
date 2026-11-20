# Sistema de Monitoreo y Telemetría de Tokens USB

Plataforma institucional de monitoreo en tiempo real, trazabilidad de uso, alertas de vencimiento de certificados y auditoría para tokens criptográficos USB.

## Arquitectura del Stack

| Servicio | Contenedor | Puerto | Rol |
| --- | --- | --- | --- |
| PostgreSQL 16 | `gestion-firmas-postgres` | `5432` | Persistencia (usuarios, certificados, tokens, estaciones, telemetría y auditoría) |
| Redis 7 | `gestion-firmas-redis` | `6379` | Presencia en vivo, TTL de conexiones y metadatos temporales |
| Backend NestJS | `gestion-firmas-backend` | `3001` | API REST (`/api/v1/*`), Swagger (`/api/docs`), WebSocket (`Socket.io`) |
| Frontend React | `gestion-firmas-frontend` | `80` (interno) | Portal web de monitoreo y administración (`../gestion-de-firmas-frontend`) |
| Gateway Nginx | `gestion-firmas-gateway` | `80`, `443` | Proxy inverso HTTPS/TLS 1.2-1.3 y upgrade WSS |

## Despliegue rápido en una VM nueva

1. **Preparar la VM (Ubuntu/Debian):**
   ```bash
   chmod +x scripts/deploy-gcp-vm.sh
   ./scripts/deploy-gcp-vm.sh
   ```

2. **Clonar repositorios hermanos y configurar variables de entorno:**
   ```bash
   # Deben quedar en el mismo directorio padre:
   # ./gestion-de-firmas y ./gestion-de-firmas-frontend
   cd gestion-de-firmas
   cp .env.example .env
   ```
   Edita `.env` reemplazando todos los valores `CHANGE_ME_*` (genera secretos con `openssl rand -hex 32`).

3. **Certificados TLS:**
   Coloca `server.crt` y `server.key` en `docker/nginx/ssl/`. Para desarrollo o pruebas internas puedes generar un certificado autofirmado:
   ```bash
   mkdir -p docker/nginx/ssl
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -keyout docker/nginx/ssl/server.key \
     -out docker/nginx/ssl/server.crt \
     -subj "/CN=localhost"
   ```
   En producción con dominio público, emite con Certbot (`/.well-known/acme-challenge/` ya está habilitado en `gateway.conf`) y enlaza `fullchain.pem`/`privkey.pem` a `server.crt`/`server.key`.

4. **Construir e iniciar el stack:**
   ```bash
   docker compose up -d --build
   ```

## Variables de Entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | Sí | Credenciales y cadena de conexión PostgreSQL |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_PRESENCE_TTL` | Sí | Conexión y TTL de presencia en Redis |
| `JWT_SECRET` | Sí | Secreto HS256 (mín. 32 bytes hex) para sesiones de 3h |
| `TELEMETRIA_API_KEY` | Sí | Clave enviada por Ghost App al reportar eventos USB |
| `TOTP_ISSUER` | No | Emisor mostrado en apps Authenticator (MFA 2FA) |
| `CORS_ORIGINS`, `PUBLIC_APP_URL` | Sí | Orígenes permitidos y URL pública del portal |
| `ADMIN_INICIAL_RUT`, `ADMIN_INICIAL_NOMBRE`, `ADMIN_INICIAL_EMAIL` | Sí | Cuenta administradora creada al iniciar base vacía |
| `ADMIN_INICIAL_PASSWORD`, `ADMIN_INICIAL_PIN` | No | Credencial inicial (si se omite se genera temporal) |
| `EXTRA_SUPERADMINS_JSON`, `SUPERADMINS_FIJOS_JSON` | No | JSON opcional de administradores protegidos/adicionales |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | No | Configuración SMTP para avisos de vencimiento |
| `MAIL_OFFICE_NAME`, `MAIL_DEPT_NAME`, `MAIL_CONTACT_PHONE`, `MAIL_CONTACT_EMAIL`, `MAIL_WEB_URL` | No | Pie institucional de la plantilla de correo |
| `DEFAULT_ORG_NAME`, `DEFAULT_DEPENDENCIA_FISICA` | No | Valores institucionales por defecto en telemetría |

## Agente de Estación de Trabajo (Ghost App)

El portal expone el descargador preconfigurado en `GET /api/v1/telemetria/descargar-agente` (autoinstalador `.bat` sin permisos de administrador ni Active Directory) y sus fuentes viven en `ghost-app/`.

El agente:
- Escanea dispositivos USB criptográficos (PnP/SmartCard y WebHID en Electron).
- Lee metadatos del certificado X.509 en Windows en UTF-8 con caché local en `%LOCALAPPDATA%\CoquimboGhostApp\token-certs-cache.json`.
- Mantiene cola offline con backoff exponencial ante cortes de red.

## Respaldos y Verificación E2E

- **Respaldo manual PostgreSQL:** `./scripts/backup.sh` (rotación de 14 días).
- **Validar `docker-compose.yml`:** `docker compose config -q`.
- **Suite E2E de integridad (sin dejar residuos en BD/Redis):**
  ```bash
  cd backend
  node test-e2e-integridad.js
  ```

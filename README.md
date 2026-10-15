# Sistema de Gestión de Firmas y Telemetría de Tokens Criptográficos

**Ilustre Municipalidad de Coquimbo** — Departamento de Gestión de Sistemas y TICs  
*Cumplimiento normativo: Ley N° 21.663 (Marco de Ciberseguridad / ANCI), Ley N° 19.799 (Firma Electrónica) e ISO/IEC 27001.*

---

## 🏛️ Estructura del Repositorio (Backend + Base de Datos con Docker)

Este repositorio contiene exclusivamente el **Backend Core, Motores de Cómputo, Caché y Bases de Datos Orquestados con Docker**:

```text
gestion-de-firmas/
├── backend/                      # Backend Core & Motor de Orquestación (NestJS + TypeScript)
│   ├── prisma/                   # Esquema relacional PostgreSQL con soporte JSONB
│   ├── src/
│   │   ├── firmas/               # Orquestación de firma asíncrona por lotes (BullMQ + Redis)
│   │   ├── telemetria/           # Ingesta de telemetría USB (Ghost App) y auditoría forense
│   │   ├── usuarios/             # Gestión de identidades, certificados y alertas de vencimiento
│   │   ├── websocket/            # Servidor Socket.io v4 con soporte WebHID en tiempo real
│   │   ├── prisma/               # Servicio de persistencia y ciclo de vida de BD
│   │   └── redis/                # Gestión de estados efímeros con TTL (3600s) y bloqueos Redlock
│   ├── Dockerfile                # Imagen multi-stage optimizada sobre Node.js 20 Alpine
│   └── package.json
│
├── docker/
│   └── nginx/
│       └── gateway.conf          # API Gateway Nginx (CORS, Proxy REST y WebSockets)
│
├── docker-compose.yml            # Orquestación (PostgreSQL 16, Redis 7, MinIO S3, Backend NestJS, Gateway)
├── .env.example                  # Parámetros y credenciales de entorno
└── ARQUITECHTURE.md              # Documentación de arquitectura de referencia
```

> [!NOTE]
> **Repositorio de Frontend Independiente (Sin Docker):**
> La aplicación cliente (React 18 + Vite + Tailwind CSS + Shadcn UI) ha sido desacoplada en el repositorio:
> **`../gestion-de-firmas-frontend/`** (se ejecuta directamente con `npm run dev` en `http://localhost:3000`).

---

## 🚀 Despliegue de Backend & Servicios con Docker Compose

Para levantar toda la infraestructura del backend con un solo comando:

```bash
# 1. Configurar variables de entorno
cp .env.example .env

# 2. Construir e iniciar contenedores
docker compose up -d --build
```

### Endpoints y Servicios Expuestos:
- **API Swagger / Documentación:** [http://localhost:3001/api/docs](http://localhost:3001/api/docs) (o vía Gateway en [http://localhost/api/docs](http://localhost/api/docs))
- **Servidor WebSockets (Telemetría):** `ws://localhost:3001`
- **Consola MinIO (Object Storage):** [http://localhost:9001](http://localhost:9001) (`minioadmin` / `minioadmin`)
- **PostgreSQL 16:** `localhost:5432` (`gestion_firmas`)
- **Redis 7 (BullMQ & TTL Cache):** `localhost:6379`

---

## 🛠️ Desarrollo Local

### Backend (NestJS)
```bash
cd backend
npm install
npx prisma generate
npm run start:dev
```

### Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev
```
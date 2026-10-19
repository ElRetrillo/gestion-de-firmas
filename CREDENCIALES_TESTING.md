# Credenciales y Base de Datos de Prueba (Entorno Desarrollo / Testing)
**Ilustre Municipalidad de Coquimbo — Sistema de Gestión de Firmas Electrónicas y Telemetría de Tokens USB**  
*Cumplimiento Normativo: Ley N° 19.799 (FEA), Ley N° 21.180 (Transformación Digital), Ley N° 21.663 (ANCI) e ISO/IEC 27001.*

---

## 1. Credenciales de Usuarios por Rol Institucional (RBAC)

La base de datos PostgreSQL (`gestion_firmas`) se inicializa automáticamente al arrancar el backend mediante [`SeedService`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/prisma/seed.service.ts). Puedes iniciar sesión en el Frontend o mediante `POST /api/v1/auth/login` con cualquiera de las siguientes cuentas oficiales de prueba:

| Rol RBAC | RUT | Nombre | Cargo / Unidad | Contraseña | PIN Token USB (eHSM) | Estado |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`ADMIN`** | `12.894.120-3` | Patricio Reyes Morales | Secretario Municipal y Administrador TIC | `AdminCoquimbo2026!` | `1234` | `ACTIVO` |
| **`SUPERVISOR`** | `14.120.932-5` | Marcela Vega Contreras | Jefa de Oficina de Partes y Archivo (DAF) | `SuperCoquimbo2026!` | `2580` | `ACTIVO` |
| **`MINISTRO_DE_FE`** | `11.554.218-1` | Eugenio Gómez Díaz | Ministro de Fe Suplente (Asesoría Jurídica) | `MinistroCoquimbo2026!` | `9999` | `ACTIVO` |
| **`FUNCIONARIO`** | `16.782.341-2` | Rodrigo Araya Campos | Analista de Gestión Documental | `FuncCoquimbo2026!` | `1234` | `ACTIVO` |
| **`FUNCIONARIO`** *(Alerta <15d)* | `14.112.980-5` | Marcelo Gómez | Director de Obras Municipales (DOM) | `FuncCoquimbo2026!` | `4321` | `ACTIVO` |
| **`FUNCIONARIO`** *(Baja RRHH <48h)* | `15.342.119-4` | Carolina Rojas Valdivia | Ex-Supervisora de Compras | `Coquimbo2026!` | `0000` *(Bloqueado)* | `DESVINCULADO` |

> **Nota sobre Política de Bloqueo PIN (FIPS 140-2 Nivel 3):**  
> Si ingresas un PIN erróneo **3 veces consecutivas** al firmar un documento (`POST /api/v1/firmas/solicitudes/:id/firmar` o `POST /api/v1/auth/verificar-pin`), el token del usuario pasará a estado `pinBloqueado = true`. Un `ADMIN` puede desbloquearlo mediante código PUK desde el módulo **"RRHH & Actas Custodia"** o vía `POST /api/v1/auth/desbloquear-pin`.

---

## 2. Credenciales de Infraestructura (Docker Compose)

| Servicio | Host / Puerto Local | Usuario / Access Key | Contraseña / Secret Key | Base de Datos /Detalles |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | `localhost:5432` | `postgres` | `postgres123` | DB: `gestion_firmas` (9 tablas + Índices GIN JSONB) |
| **Redis 7 (Cache & BullMQ)** | `localhost:6379` | *(Sin usuario)* | *(Sin password en dev)* | TTL Presencia: `3600s` + Redlock Distribuido |
| **MinIO S3 (Object Storage)** | API: `localhost:9000` / Consola: `http://localhost:9001` | `minioadmin` | `minioadmin` | Almacenamiento de PDFs y Actas de Custodia |
| **Backend Core (NestJS)** | `http://localhost:3001` | Swagger: `/api/docs` | JWT Secret: `coquimbo_secret_key_ciberseguridad_2026` | API v1 + WebSockets Socket.io |
| **Nginx Gateway** | `http://localhost:80` | Proxy Inverso | Rate Limit: `10r/s` | Enrutamiento `/api/` y `/socket.io/` |
| **Webhooks HMAC-SHA256** | `POST /api/v1/integraciones/webhooks/:servicio` | Header: `x-Georg-Signature` / `x-webhook-signature` | Secret: `ciberseguridad-municipio-key-2026` | Servicios: `FIRMAGOB`, `ESIGN_CHILE`, `CLAVE_UNICA` |

---

## 3. Datos Semilla Precargados para Pruebas Inmediatas

1. **Estaciones de Trabajo (`estaciones_trabajo` + Redis TTL 3600s):**
   - `PC-SECMUN-01` (`10.20.1.10`) — **CONECTADO** (`SN-SAF-98214`)
   - `PC-DOM-05` (`10.20.2.45`) — **FIRMANDO** (`SN-FEI-44102`)
   - `PC-ALCALDIA-01` (`10.20.0.5`) — **CONECTADO** (`SN-SAF-10092`)
   - `PC-DAF-02` (`10.20.1.12`) — **CONECTADO** (`SN-ATH-77310`)
   - `PC-TRANSITO-03` (`10.20.3.18`) — **DESCONECTADO**

2. **Expedientes y Solicitudes de Firma (`solicitudes_firma`):**
   - `DEC-ALC-2026-0904` — *Decreto Alcaldicio N° 904* (`FIRMADA`, Fe Pública: `ATESTADO`, Código Checksign: `VERIF-CQBO-904-2026`, Registro Notarial: `REG-FE-SECMUN-8841-2026`).
   - `DEC-ALC-2026-1482` — *Decreto Alcaldicio Exento N° 1.482* (`PENDIENTE`, requiere Fe Pública del Ministro de Fe).
   - `CON-HON-2026-0412` — *Contrato a Honorarios Profesional Informático* (`EN_VISACION`).
   - `PERM-DOM-2026-0088` — *Permiso de Edificación Obra Nueva* (`PENDIENTE`).
   - `OC-DAF-2026-0771` — *Orden de Compra Licencias Criptográficas* (`PENDIENTE`).

3. **Comandos Útiles de Verificación:**
   - **Consultar credenciales desde la API:** `GET http://localhost:3001/api/v1/auth/credenciales-prueba`
   - **Restaurar BD de prueba a su estado original:** `POST http://localhost:3001/api/v1/auth/seed-reset`
   - **Ejecutar Simulador del Agente Ghost App (Electron):** `node ghost-app/simulator.js`

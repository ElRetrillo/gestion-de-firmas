# Resumen de Cambios e Implementaciones del Sistema
**Sistema de Gestión de Firmas Electrónicas y Telemetría de Tokens USB**  
**Ilustre Municipalidad de Coquimbo — Entorno de Desarrollo y Testing**  
*Fecha: 19 de Octubre de 2026*  
*Normativa: Ley N° 19.799 (FEA), Ley N° 21.180 (Transformación Digital), Ley N° 21.663 (ANCI) e ISO/IEC 27001.*

---

## 1. Resumen Ejecutivo

Se completó e integró la arquitectura descrita en [`ARQUITECHTURE.md`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/ARQUITECHTURE.md) en todas sus capas:
1. **Base de Datos y Persistencia:** PostgreSQL 16 con Prisma ORM, Redis 7 (caché efímera de presencia, colas BullMQ y locks distribuidos Redlock), con soporte de índices GIN JSONB y población automática de datos de prueba (`SeedService`).
2. **Backend Core (NestJS):** Módulos completos de Autenticación JWT, Seguridad eHSM/PIN/PUK, Orquestación de Firmas en Lotes y Firmas Individuales, Atestación de Fe Pública Notarial, Generación de Documentos y Actas en PDF con `pdf-lib`, Gobernanza de Usuarios con protocolo de desvinculación RRHH (<48h), Alertas preventivas de certificados X.509, Equipamiento/Custodia de Tokens USB, Auditoría Forense ANCI y Webhooks HMAC-SHA256.
3. **Agente Local (Electron Ghost App):** Agente silencioso headless en Node.js/Electron con detección automática de `os.hostname()`, escaneo de hardware USB/WebHID para tokens criptográficos y cola de resiliencia con Exponential Backoff.
4. **Frontend Institucional (React 19 + Vite 6 + Tailwind CSS):** Interfaz completa conectada a los endpoints del backend, cálculo criptográfico SHA-256 en cliente vía Web Crypto API, selector de credenciales de prueba con 1-click y nuevo módulo de gestión de identidades y actas de custodia.
5. **Documentación y Dockerización:** Documento de credenciales de testing ([`CREDENCIALES_TESTING.md`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/CREDENCIALES_TESTING.md)), `Dockerfile` de producción para el frontend y corrección de librerías nativas OpenSSL 3.0 en contenedor de backend Alpine.

---

## 2. Modificaciones en Base de Datos y Prisma ORM

### 2.1. Expansión del Esquema (`backend/prisma/schema.prisma`)
Se definieron e implementaron las 9 entidades relacionales y 12 enums de la arquitectura:
- [`Usuario`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L88): Soporte para roles (`ADMIN`, `SUPERVISOR`, `MINISTRO_DE_FE`, `FUNCIONARIO`), estados (`ACTIVO`, `EN_LICENCIA`, `SUSPENDIDO`, `DESVINCULADO`), hashes de clave y PIN, contador de intentos fallidos (`intentosPinFallidos`) y flag de seguridad `pinBloqueado` (política FIPS 140-2 Nivel 3).
- [`Certificado`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L112): Control de certificados X.509 (`FIRMAGOB`, `ESIGN`), custodia (`TOKEN_FISICO`, `CLOUD`) y vigencia (`VIGENTE`, `POR_VENCER`, `REVOCADO`, `VENCIDO`).
- [`TokenHardware`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L131): Registro patrimonial de tokens USB SafeNet, Athena, Feitian y Gemalto.
- [`EstacionTrabajo`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L147): Estaciones de trabajo físicas municipales, dependencia, IP, serial activo y estado de conexión.
- [`TelemetriaEvento`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L162): Eventos de inserción/extracción y firma con metadatos JSONB forenses.
- [`SolicitudFirma`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L175): Flujos de visación y firma escalonada, materia, folios, clasificación documental, hash SHA-256, sellado de tiempo RFC 3161, código Checksign y Fe Pública.
- [`ActaCustodia`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L204): Trazabilidad de entrega, devolución, traspaso o baja patrimonial de tokens criptográficos.
- [`HistorialCambio`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L222): Bitácora inmutable de auditoría forense con diff JSONB (Ley ANCI N° 21.663).
- [`IntegracionApi`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/prisma/schema.prisma#L239): Configuración y credenciales cifradas para integraciones externas (FirmaGob, ESIGN, ClaveÚnica).
- Configuración de `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` para compatibilidad nativa de motores Prisma en contenedores Alpine 3.19+.

### 2.2. Índices Criptográficos GIN JSONB en PostgreSQL
Se crearon y verificaron índices invertidos generalizados en PostgreSQL para acelerar consultas forenses sobre estructuras JSONB:
- `idx_telemetria_metadatos_gin` sobre `telemetria_eventos USING gin (metadatos_jsonb)`.
- `idx_historial_diff_gin` sobre `historial_cambios USING gin (diff_jsonb)`.
- `idx_solicitudes_flujo_gin` sobre `solicitudes_firma USING gin (flujo_visacion_jsonb)`.

### 2.3. Servicio de Semilla Automatizado (`backend/src/prisma/seed.service.ts`)
- Ejecutado automáticamente en el ciclo de inicio `onModuleInit()`.
- Verifica la existencia de los índices GIN.
- Si la base de datos está vacía, inserta el padrón completo de usuarios de prueba, tokens USB, certificados, estaciones de trabajo, actas de custodia, expedientes de firma e integraciones.
- Sincroniza la presencia de las estaciones en Redis con `TTL = 3600s`.
- Expone el método `ejecutarSeedInicial(true)` para resetear la base de datos a petición.

---

## 3. Módulos y Servicios del Backend Core (NestJS)

### 3.1. Módulo de Redis y Bloqueo Distribuido (`backend/src/redis/`)
- [`redis.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/redis/redis.service.ts):
  - Gestión de presencia de hardware USB con TTL de 3600 segundos.
  - Implementación de bloqueo distribuido estilo Redlock (`acquireLock` con token criptográfico y `releaseLock` mediante script Lua atómico) para evitar colisiones y dobles firmas simultáneas en lotes.
  - Fallback en memoria en caso de desconexión temporal de Redis.

### 3.2. Módulo de Autenticación y Seguridad eHSM (`backend/src/auth/`)
- [`auth.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/auth/auth.service.ts) y [`auth.controller.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/auth/auth.controller.ts):
  - `POST /api/v1/auth/login`: Autenticación con RUT y contraseña, generación de token JWT (HS256) con claims institucionales. Rechaza usuarios en estado `DESVINCULADO` o `SUSPENDIDO`.
  - `POST /api/v1/auth/verificar-pin`: Verificación de PIN criptográfico del token USB. Bloquea la credencial al alcanzar 3 intentos fallidos (FIPS 140-2).
  - `POST /api/v1/auth/desbloquear-pin`: Restablecimiento de PIN mediante código PUK administrativo.
  - `GET /api/v1/auth/credenciales-prueba`: Retorna catálogo institucional de usuarios y credenciales de prueba.
  - `POST /api/v1/auth/seed-reset`: Restaura la base de datos PostgreSQL y Redis a los valores semilla originales.

### 3.3. Módulo de Firmas, Fe Pública y Checksign (`backend/src/firmas/`)
- [`firmas.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/firmas/firmas.service.ts), [`firmas.controller.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/firmas/firmas.controller.ts) y [`firmas.processor.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/firmas/firmas.processor.ts):
  - `POST /api/v1/firmas/solicitudes`: Ingreso de solicitud de firma con cadena jerárquica de visación y clasificación.
  - `GET /api/v1/firmas/solicitudes`: Bandeja documental con filtros por estado, clasificación, RUT y requerimiento de Fe Pública.
  - `POST /api/v1/firmas/solicitudes/:id/firmar`: Firma individual con validación de PIN en token USB, bloqueo distribuido en Redis, actualización de flujo de visación, generación de código Checksign y registro en auditoría.
  - `POST /api/v1/firmas/solicitudes/:id/fe-publica`: Atestación notarial del Ministro de Fe Municipal (Secretario Municipal), generando número de registro notarial (`REG-FE-2026-CQM-XXXX`) según Art. 20 de la Ley N° 18.695.
  - `GET /api/v1/firmas/solicitudes/:id/pdf`: Generación y descarga de documento PDF real con `pdf-lib` (encabezado institucional, metadatos del acto, cadena de visadores, sello de Fe Pública y pie criptográfico Checksign).
  - `POST /api/v1/firmas/lotes/procesar`: Encolado y procesamiento en segundo plano con BullMQ y persistencia de lotes firmados.
  - `POST /api/v1/firmas/checksign/verificar`: Verificación de integridad documental por código, folio o hash SHA-256.
  - `GET /api/v1/firmas/checksign/:codigo/certificado-pdf`: Generación y descarga en PDF del Certificado Oficial de Validación Criptográfica Checksign.

### 3.4. Módulo de Gobernanza de Usuarios y RRHH (`backend/src/usuarios/`)
- [`usuarios.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/usuarios/usuarios.service.ts) y [`usuarios.controller.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/usuarios/usuarios.controller.ts):
  - `GET/POST /api/v1/usuarios`: Padrón de funcionarios habilitados.
  - `PATCH /api/v1/usuarios/:id/estado`: Protocolo de desvinculación RRHH (<48h). Al desvincular un usuario, revoca automáticamente todos sus certificados vigentes, pasa sus tokens a estado `EN_REVISION` y registra la traza forense.
  - `GET /api/v1/usuarios/alertas-vencimiento`: Radar de ciclo de vida con escalas preventiva (<60d), alerta (<30d) y crítica (<15d).
  - `POST /api/v1/usuarios/alertas-vencimiento/despachar`: Emisión de notificaciones y órdenes de renovación.

### 3.5. Módulo de Equipamiento y Actas de Custodia (`backend/src/equipamiento/`)
- [`equipamiento.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/equipamiento/equipamiento.service.ts) y [`equipamiento.controller.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/equipamiento/equipamiento.controller.ts):
  - `GET/POST /api/v1/equipamiento/tokens`: Inventario patrimonial de tokens físicos USB.
  - `GET/POST /api/v1/equipamiento/actas`: Generación de actas digitales de entrega, devolución, traspaso o baja.
  - `GET /api/v1/equipamiento/actas/:id/pdf`: Emisión de Acta Oficial en PDF con formato legal y firma de recepción conforme.

### 3.6. Módulo de Auditoría Forense ANCI (`backend/src/auditoria/`)
- [`auditoria.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/auditoria/auditoria.service.ts) y [`auditoria.controller.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/auditoria/auditoria.controller.ts):
  - `GET /api/v1/auditoria`: Consulta de bitácora inalterable con filtros por tabla, registro y actor.
  - `GET /api/v1/auditoria/estadisticas`: Métricas de operaciones y desglose de mutaciones para reportes CGR/ANCI.

### 3.7. Módulo de Integraciones y Webhooks (`backend/src/integraciones/`)
- [`integraciones.service.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/integraciones/integraciones.service.ts) y [`integraciones.controller.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/src/integraciones/integraciones.controller.ts):
  - `GET /api/v1/integraciones`: Estado de conectividad de servicios externos.
  - `POST /api/v1/integraciones/webhooks/:servicio`: Receptor de eventos webhook con validación obligatoria de firmas HMAC-SHA256 (`crypto.timingSafeEqual`) contra ataques de sincronización.

### 3.8. Telemetría y WebSockets (`backend/src/telemetria/` y `backend/src/websocket/`)
- Ingesta de eventos físicos USB vía `POST /api/v1/telemetria/usb`.
- Difusión en tiempo real mediante Socket.io hacia la sala `dashboard-supervisores`.
- Método `emitirActualizacionPresencia` para notificar actualizaciones de lotes y firmas a los clientes conectados.

---

## 4. Agente Local Silencioso (Electron Ghost App)

Directorio creado: [`ghost-app/`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/ghost-app)
- [`package.json`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/ghost-app/package.json): Configuración del paquete y scripts de ejecución.
- [`main.js`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/ghost-app/main.js):
  - Ejecución en segundo plano sin ventana gráfica (`show: false`, `skipTaskbar: true`).
  - Identificación automática de la estación mediante `os.hostname()`.
  - Inspección de dispositivos PnP en Windows para tokens criptográficos (SafeNet VID `0529`, Athena VID `0DC3`, Feitian VID `096E`, Gemalto VID `08E6`).
  - Cola en disco con política de reintentos mediante **Exponential Backoff** ante caídas de red local.
- [`simulator.js`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/ghost-app/simulator.js):
  - Script independiente para simular ráfagas de telemetría multi-estación (`PC-SECMUN-01`, `PC-DOM-05`, estación local activa) sin necesidad de GUI.

---

## 5. Frontend Institucional (React + Vite + Tailwind)

### 5.1. Conexión de Estado y Autenticación
- [`useAuthStore.ts`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/store/useAuthStore.ts): Gestión de perfil autenticado, almacenamiento del token JWT, rol activo y PIN asignado para pruebas.
- [`LoginModal.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/LoginModal.tsx): Formulario institucional conectado al endpoint `POST /api/v1/auth/login` con selector de autocompletado en 1 clic para los roles `ADMIN`, `SUPERVISOR`, `MINISTRO_DE_FE` y `FUNCIONARIO`.

### 5.2. Nuevo Módulo de Gobernanza RRHH y Custodia
- [`GestionUsuariosEquipamientoView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/GestionUsuariosEquipamientoView.tsx):
  - Padrón de funcionarios con visualización de estado y alertas de PIN bloqueado.
  - Botón de **"Baja RRHH (<48h)"** que ejecuta la desvinculación y revocación inmediata de certificados en backend.
  - Botón de **"Desbloquear PUK"** para rehabilitar tokens bloqueados por exceso de intentos de PIN.
  - Formulario de enrolamiento de nuevos funcionarios.
  - Registro y emisión de **Actas Digitales de Custodia de Tokens USB** con enlace directo a descarga de comprobante PDF oficial.

### 5.3. Actualización de Vistas Operativas
- [`App.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/App.tsx) y [`Sidebar.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/Sidebar.tsx): Inclusión del nuevo módulo `USUARIOS_CUSTODIA`, actualización de la matriz de permisos RBAC y conmutador de vistas (Admin / Funcionario).
- [`TopHeader.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/TopHeader.tsx): Registro de metadatos y títulos para la nueva sección de gobernanza.
- [`ChecksignView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/ChecksignView.tsx):
  - Cálculo de hash SHA-256 en el cliente utilizando Web Crypto API nativa (`window.crypto.subtle.digest`) al arrastrar archivos locales.
  - Consulta al endpoint `POST /api/v1/firmas/checksign/verificar`.
  - Descarga del Certificado Oficial de Validación Criptográfica en PDF.
- [`FirmaLotesView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/FirmaLotesView.tsx): Consulta de solicitudes desde el backend, despacho masivo con BullMQ y enlaces a los documentos firmados.
- [`MisDocumentosFuncionarioView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/MisDocumentosFuncionarioView.tsx): Bandeja personal conectada a la base de datos, firma individual con validación de PIN eHSM y modal de descarga de PDF con estampa FEA.
- [`FePublicaDecretosView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/FePublicaDecretosView.tsx): Bandeja notarial de decretos para el Ministro de Fe, otorgamiento de Fe Pública y descarga del decreto certificado.
- [`AlertasCertificadosView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/AlertasCertificadosView.tsx): Conectada a las alertas calculadas por el backend y despacho masivo preventivo.
- [`AuditoriaView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/AuditoriaView.tsx): Visualizador en vivo de la bitácora inmutable de auditoría forense con inspección de diffs JSONB.
- [`ConfiguracionSistemaView.tsx`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/ConfiguracionSistemaView.tsx): Parámetros de red, botón de prueba de webhooks HMAC-SHA256 y botón de restauración de base de datos de prueba.

---

## 6. Dockerización y Estabilidad en Alpine Linux

- **Corrección OpenSSL en Contenedor Backend:**  
  Se actualizó el [`Dockerfile`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/backend/Dockerfile) agregando `apk add --no-cache openssl` tanto en la etapa `builder` como en `runner`, resolviendo la incompatibilidad de librerías dinámicas (`libssl.so.1.1` vs OpenSSL 3.0) con Prisma en Alpine Linux.
- **Dockerfile Frontend:**  
  Se creó el archivo [`gestion-de-firmas-frontend/Dockerfile`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas-frontend/Dockerfile) multi-etapa con compilación en Node 20 y servidor Nginx 1.27 optimizado para producción.

---

## 7. Credenciales Oficiales de Prueba y Acceso

Documentadas en detalle en [`CREDENCIALES_TESTING.md`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/CREDENCIALES_TESTING.md):

| Rol RBAC | RUT | Funcionario | Cargo / Unidad | Contraseña | PIN Token USB |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`ADMIN`** | `12.894.120-3` | Patricio Reyes Morales | Secretario Municipal y Administrador TIC | `AdminCoquimbo2026!` | `1234` |
| **`SUPERVISOR`** | `14.120.932-5` | Marcela Vega Contreras | Jefa de Oficina de Partes y Archivo (DAF) | `SuperCoquimbo2026!` | `2580` |
| **`MINISTRO_DE_FE`** | `11.554.218-1` | Eugenio Gómez Díaz | Ministro de Fe Suplente (Asesoría Jurídica) | `MinistroCoquimbo2026!` | `9999` |
| **`FUNCIONARIO`** | `16.782.341-2` | Rodrigo Araya Campos | Analista de Gestión Documental | `FuncCoquimbo2026!` | `1234` |
| **`FUNCIONARIO`** *(DOM)* | `14.112.980-5` | Marcelo Gómez | Director de Obras Municipales | `FuncCoquimbo2026!` | `4321` |
| **`FUNCIONARIO`** *(Baja RRHH)* | `15.342.119-4` | Carolina Rojas Valdivia | Ex-Supervisora de Compras | `Coquimbo2026!` | `0000` *(Bloqueado)* |

### Endpoints y Servicios Activos
- **Swagger / OpenAPI:** `http://localhost:3001/api/docs`
- **Consulta de Credenciales:** `GET http://localhost:3001/api/v1/auth/credenciales-prueba`
- **Reinicio de Base de Datos Semilla:** `POST http://localhost:3001/api/v1/auth/seed-reset`
- **Simulador de Telemetría Ghost App:** `node ghost-app/simulator.js`
- **MinIO S3 Console:** `http://localhost:9001` (User: `minioadmin` / Pass: `minioadmin`)

# Contexto y Especificación de Arquitectura: Sistema de Gestión de Firmas y Telemetría de Tokens

    ## 1. Contexto del Negocio y Dominio
    - **Institución:** Ilustre Municipalidad de Coquimbo (Depto. de Gestión de Sistemas y TICs).
    - **Objetivo General:** Plataforma centralizada para automatizar el ciclo de vida de identidades
  digitales, gestionar certificados de firma electrónica (FirmaGob y FEA Privada ESIGN), orquestar
  la firma masiva/por lotes y supervisar en tiempo real la conexión física de tokens criptográficos
  USB en estaciones de trabajo municipales.
    - **Marco Normativo:** Ley N° 21.663 (Marco de Ciberseguridad / ANCI), Ley N° 19.799 (Firma
  Electrónica), Ley N° 21.180 (Transformación Digital) e ISO/IEC 27001.

    ---

  ## 2. Stack Tecnológico Oficial

  ### 2.1. Backend Core & Motor de Orquestación de Firmas
  - **Runtime & Lenguaje:** Node.js 20+ LTS con **TypeScript** configurado en modo estricto (`strict: true`).
  - **Framework:** **NestJS 10+** (arquitectura modular por dominios, inyección de dependencias, controladores REST desacoplados y servicios transaccionales).
  - **Validación de Esquemas:** `class-validator` y `class-transformer` para validación estricta de DTOs en tiempo de ejecución conforme a estándares ANCI.
  - **Procesamiento Asíncrono y Colas:** **BullMQ** sobre **Redis 7+** para la orquestación en segundo plano de lotes de firma masiva (batch), reintentos con *exponential backoff* y tareas programadas (alertas preventivas de vencimiento a 60, 30 y 15 días).
  - **Criptografía y Procesamiento de Documentos:**
    - Manipulación y estampado de documentos PDF mediante `pdf-lib`.
    - Hashing criptográfico SHA-256 / SHA-512 y estampado cronológico conforme a la norma RFC 3161 (TSA).
    - Integración con librerías PKCS#11 y protocolos de Firma Electrónica Avanzada (FEA) de ESIGN y FirmaGob.
  - **Documentación de API:** OpenAPI / Swagger (`@nestjs/swagger`) disponible en `/api/docs`.

  ### 2.2. Capa de Comunicación en Tiempo Real y Estado Efímero
  - **Servidor WebSockets:** **Socket.io v4** integrado nativamente en NestJS (`@nestjs/platform-socket.io`).
  - **Escalabilidad Horizontal:** Adaptador `@socket.io/redis-adapter` para sincronización de eventos de telemetría entre réplicas del backend.
  - **Seguridad en Transmisión:** Handshake autenticado y segmentación de eventos por salas privadas (`dashboard-supervisores`, `unidad-{id}`).
  - **Caché y Presencia de Hardware:** **Redis 7+** gestionando llaves `pc:status:{codigoPC}` con expiración estricta (TTL 3600s con refresco continuo por ping de telemetría) para evitar falsos positivos ante apagados abruptos.
  - **Concurrencia Segura:** Bloqueos distribuidos (*distributed locks* vía Redlock) para evitar colisiones en firmas simultáneas.

  ### 2.3. Persistencia y Almacenamiento de Evidencias
  - **Base de Datos Relacional Principal:** **PostgreSQL 16+**:
    - Soporte nativo de columnas `JSONB` con índices GIN en tablas de auditoría y telemetría (`metadatos_jsonb`, `diff_jsonb`, `flujo_visacion_jsonb`) para consultas forenses de alta velocidad exigidas por ANCI y CGR.
  - **ORM & Migraciones:** **Prisma ORM** para modelado tipado, control de migraciones declarativas y consultas transaccionales con integridad referencial.
  - **Almacenamiento de Evidencias (Object Storage):** Repositorio compatible con S3 (**MinIO** en infraestructura on-premise municipal o Cloud Storage) con cifrado en reposo (AES-256) para actas de custodia y PDFs firmados.

  ### 2.4. Frontend (Portal de Gestión, Dashboard de Supervisión y Checksign)
  - **Framework & Build Tool:** **React 18+** con **Vite** para carga ultrarrápida, bajo consumo de memoria y compatibilidad con navegadores corporativos.
  - **Directrices de Diseño (Estética Gubernamental e Institucional):**
    - **Sobriedad y Funcionalidad:** Basado en la Guía de Diseño Digital del Estado de Chile. Sin animaciones superfluas o lúdicas; transiciones funcionales inmediatas.
    - **Accesibilidad y Legibilidad:** Conformidad con el estándar WCAG 2.1 nivel AA (alto contraste, tipografía institucional clara, formularios estructurados).
    - **Paleta Semántica Controlada:** Fondos neutros, escalas de grises y azul institucional (`#003366`); el uso de colores saturados se reserva estrictamente para estados críticos de telemetría de hardware:
      - 🔴 **Desconectado:** Sin token físico detectado.
      - 🟢 **Conectado:** Token presente en la ranura USB y validado.
  - **Estilos & Componentes:** **Tailwind CSS** + iconos limpios (**Lucide Icons**).
  - **Gestión de Estado & Sincronización:** **Zustand** para la gestión de estados globales reactivos y eventos en vivo del WebSocket + **TanStack Query (React Query)** para caché y deduplicación de peticiones REST.
  - **Portal Público Checksign:** Verificador de autenticidad documental mediante cálculo de hash SHA-256 e inspección de sellos de tiempo RFC 3161 y acreditación de prestador (Ley N° 19.799).

  ### 2.5. Uso de Docker, Contenedores e Infraestructura
  - **Arquitectura de Contenedores:** Multi-stage builds optimizados bajo imágenes Linux Alpine para minimizar superficie de ataque y tamaño de imagen:
    - `backend/Dockerfile`: Etapa de compilación TypeScript + generación Prisma Client sobre `node:20-alpine`, runner de producción ejecutado con usuario no root (`USER node`).
    - `frontend/Dockerfile`: Etapa de compilación Vite sobre `node:20-alpine`, servida en producción mediante `nginx:alpine` con compresión gzip, caché de estáticos y cabeceras de seguridad ANCI.
  - **Orquestación con Docker Compose (`docker-compose.yml`):**
    - `postgres`: PostgreSQL 16 Alpine con healthcheck (`pg_isready`) y volumen persistente `postgres_data`.
    - `redis`: Redis 7 Alpine con persistencia AOF y healthcheck (`redis-cli ping`).
    - `minio`: Servidor S3 MinIO con consola web de administración de evidencias.
    - `backend`: Servicio NestJS con espera de dependencias saludables (`service_healthy`).
    - `frontend`: SPA React servida en Nginx.
    - `gateway`: Reverse Proxy / API Gateway Nginx unificado en puerto 80/443 con enrutamiento de `/api/`, actualización de protocolos para `/socket.io/` (WebSockets) y entrega de la SPA.
  - **Redes y Volúmenes:** Red interna en puente `gestion-firmas-net` con aislamiento de base de datos y volúmenes dedicados para persistencia ante reinicios.


    ---

    ## 3. Módulos Funcionales

    1. **Módulo Usuario:**
       - Perfil de funcionario (RUT, email institucional, unidad, cargo, condición contractual).
       - RBAC con principio de mínimo privilegio.
       - Ciclo de vida: `Activo`, `En Licencia`, `Suspendido`, `Desvinculado`.
       - Alerta y bloqueo inmediato ante desvinculaciones reportadas por RRHH (<48h).

    2. **Módulo Firma:**
       - Tramitación de formularios de solicitud con visación jerárquica.
       - Administración de certificados (FirmaGob Cloud y FEA ESIGN PKCS#11 / Cloudsigner).
       - Alertas automáticas de vencimiento a 60, 30 y 15 días.
       - Motor de firma masiva por lotes (batch) asíncrono para Secretaría Municipal y Direcciones.

    3. **Módulo Equipamiento y Telemetría USB:**
       - Inventario de tokens USB (`vendorId`, número de serie, marca, modelo).
       - Ingesta de telemetría en tiempo real desde la Ghost App.
       - Generación y firma digital de actas de custodia (entrega, devolución, traspaso, baja).

    4. **Módulo Información y Monitoreo (Dashboard en Vivo):**
       - Panel de supervisión con actualización por WebSockets:
         - 🔴 **DESCONECTADO:** Estación sin token detectado.
         - 🟢 **CONECTADO:** Token presente y validado físicamente en el equipo.
       - Clasificación documental: *Pública, Interna, Confidencial, Crítica*.
       - Portal `Checksign` de validación de autenticidad documental.

    5. **Módulo Modificación de Datos y Auditoría:**
       - Solicitudes de cambio de datos, roles o traslados.
       - Administración segura de PIN y desbloqueos.
       - *Audit Trail* inalterable (timestamp, IP, hostname, usuario, diff JSONB) compatible con
  ANCI y CGR.

    6. **Módulo Integraciones y APIs Externas:**
       - Ingesta de telemetría: `POST /api/v1/telemetria/usb`.
       - Conectores webhooks firmados con HMAC para ESIGN y FirmaGob.
       - Componentes embebibles (widgets/botones) para DOM, SECPLAN y Decretos.

    ---

    ## 4. Arquitectura de Telemetría USB (Flujo de 3 Capas)

    > **Diagram exceeds terminal width (156 > 102 cols)**
    > Displayed as code block. Widen terminal to view inline.

    ```mermaid
    sequenceDiagram
        participant PC as Electron Ghost App (PC-SECMUN-02)
        participant API as Backend Core (NestJS)
        participant Redis as Redis (Caché de Presencia)
        participant DB as PostgreSQL
        participant Dash as Dashboard Supervisores (Socket.io)

        Note over PC: Detección WebHID (connect/disconnect) filtrado por vendorId
        PC->>API: POST /api/v1/telemetria/usb { codigoPC, estadoHardware, timestamp }
        API->>Redis: SET pc:status:PC-SECMUN-02 "CONECTADO" EX 3600
        API->>DB: INSERT into telemetria_eventos (forense)
        API->>Dash: io.to('dashboard-supervisores').emit('estado_pc_actualizado', payload)
        Note over Dash: Indicador conmuta a Amarillo (CONECTADO)

### Especificación de la Ghost App (Electron)

  • Modo headless sin ventana: show: false, skipTaskbar: true, openAtLogin: true.
  • Resuelve codigoPC desde os.hostname().
  • Captura eventos vía navigator.hid.addEventListener('connect' | 'disconnect').
  ──────

## 5. Esquema de Base de Datos Relacional (PostgreSQL)

  Tablas principales que debes considerar en el modelo:

  • usuarios: id, rut, nombre, email, cargo, unidad, rol, estado (ACTIVO, DESVINCULADO, etc.).
  • certificados: id, usuario_id, tipo (FIRMAGOB, ESIGN), custodia (CLOUD, TOKEN_FISICO),
  valido_hasta, estado.
  • tokens_hardware: id, serial_number, vendor_id, marca, modelo, estado_patrimonial.
  • estaciones_trabajo: id, codigo_pc (hostname), ip_asignada, dependencia_fisica, ultimo_ping.
  • telemetria_eventos: id, codigo_pc, token_id, evento (CONECTADO, DESCONECTADO),
  timestamp, metadatos_jsonb.
  • solicitudes_firma: id, usuario_solicitante_id, tipo_tramite, estado_aprobacion,
  flujo_visacion_jsonb.
  • actas_custodia: id, token_id, usuario_id, tipo_acta, documento_firmado_url.
  • historial_cambios: id, tabla_afectada, registro_id, accion, usuario_id, diff_jsonb, created_at.
  • integraciones_api: id, servicio, credenciales_cifradas, webhook_secret.
  ──────

## 6. Instrucciones y Directrices para el Agente de IA

  Cuando se te solicite implementar código, scripts, DDL o componentes para este proyecto:

  1. Seguridad y Ciberseguridad Primero: Aplica validación estricta de esquemas (Zod/class-
  validator), autenticación con JWT/API Keys en endpoints de telemetría y protección contra
  CSRF/CORS.
  2. Resiliencia ante Fallos de Red: Maneja la pérdida de conectividad en el agente Electron
  mediante reintentos con exponential backoff.
  3. Manejo de Estados con TTL: El estado del hardware en Redis siempre debe utilizar expiración
  (TTL) para evitar falsos positivos si una PC se apaga bruscamente.
  4. Trazabilidad y Auditoría: Toda mutación crítica de datos o eventos de firma debe generar una
  entrada en historial_cambios o telemetria_eventos con payload JSONB.
  5. Separación de Responsabilidades: Mantén desacoplada la capa de ingesta de telemetría del motor
  de firma y la lógica de negocio.

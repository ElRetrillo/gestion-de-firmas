# Arquitectura del Sistema y Documentación de Módulos para Implementación Futura
**Ilustre Municipalidad de Coquimbo — Sistema de Control y Trazabilidad de Tokens FEA**

> Copia espejo de referencia en el repositorio raíz. Ver también `C:\Users\Daniel UCN\gestion-de-firmas-frontend\ARQUITECTURA_Y_MODULOS_FUTUROS.md`.

## 1. Alcance Actual (Trazabilidad y Telemetría de Tokens USB)
- **Detección e Identificación Automática (`ghost-app/main.js`)**: Detecta la inserción física del token USB (`Win32_PnPEntity`) y extrae automáticamente del almacén de certificados de Windows (`Cert:\CurrentUser\My`) el **nombre del titular (`CN`)**, **correo (`E`)**, **cargo (`T`)**, **unidad (`OU`)** y **fecha de expiración (`NotAfter`)**, enviándolo a `POST /api/v1/telemetria/usb`.
- **Persistencia y Tiempo Real (`backend/src/telemetria/telemetria.service.ts`)**: Almacena los metadatos del titular en Redis (`token:cert_meta:<serialNumber>`) y PostgreSQL (`telemetria_eventos.metadatosJsonb`), notificándolo por WebSocket al panel de supervisión.
- **Panel de Administración (`DashboardSupervisores.tsx`)**: Muestra a quién pertenece el token insertado (`Titular Token USB`), sus conexiones/desconexiones y su promedio de uso diario (`hrs; mins`).

## 2. Módulos Preservados para Implementación Futura
1. **Firma Criptográfica Local PAdES / PKCS#7 con Token USB y `.p12`**:
   - Puente local en `ghost-app/main.js` (`http://127.0.0.1:48921/sign-digest`) + endpoints `POST /api/v1/firmas/pades/preparar` y `/completar` en `backend/src/firmas/firmas.service.ts`.
2. **Integración API FirmaGob v2 (Etapa A Desatendida / Etapa B OTP)**:
   - Implementada en `backend/src/firmas/firmagob.service.ts` y `POST /api/v1/firmas/v2/enviar`.
3. **Matriz RBAC de 12 Grados Municipales**:
   - Implementada en `backend/src/auth/rbac-firmas.policy.ts` y `frontend/src/lib/rbacFirmas.ts`.
4. **Repositorio de Documentos Firmados, QR Verificable (`/validar`) y Privacidad Ley N° 21.719**:
   - Implementados en `RepositorioDocumentosView.tsx`, `ValidadorDocumentoView.tsx` y `firmas.controller.ts` (`GET /api/v1/firmas/repositorio/:codigo/pdf` restringido al titular firmante).

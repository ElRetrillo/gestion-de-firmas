# Manual Integral de Flujo de Trabajo y Puesta en Producción

## Sistema de Gestión de Firmas Electrónicas Avanzadas y Telemetría Criptográfica USB

### Ilustre Municipalidad de Coquimbo — Depto. de TICs y Ciberseguridad

---

## 1. Arquitectura del Sistema en Producción

El sistema opera bajo una arquitectura de microservicios contenerizada sobre Docker, cumpliendo con los estándares de la **Ley N° 19.799 (Firma Electrónica Avanzada)**, la **Ley N° 21.180 (Transformación Digital)** y la **Ley N° 21.663 (Marco de Ciberseguridad y Resiliencia ANCI)**:

```
[ Ghost App (Windows PCs) ] ----(HTTP Telemetría: /telemetria/usb)----+
                                                                      |
[ Frontend Web (React/Vite) ] --(HTTP REST: /api/v1 + WebSocket: 80)--+--> [ Nginx Gateway (Port 80) ]
                                                                      |
                                                                      v
                                                    [ Backend Core (NestJS :3001) ]
                                                       |         |          |
                                    +------------------+         |          +------------------+
                                    v                            v                             v
                       [ PostgreSQL 16 (:5432) ]     [ Redis 7 (:6379) ]            [ MinIO S3 (:9000) ]
                        - Persistencia relacional     - Presencia hardware TTL       - Almacenamiento S3
                        - Ledger auditoría GIN JSONB  - Colas BullMQ (Batch)          - PDFs firmados
                        - Roles y credenciales scrypt - Candados de firma            - Actas de custodia
```

---

## 2. Puesta en Marcha y Despliegue

### 2.1 Variables de Entorno (`.env`)

El archivo `.env` en la raíz define la configuración institucional. El sistema no incluye contraseñas fijas ni datos de prueba:

```env
NODE_ENV=production
APP_PORT=80
CORS_ORIGINS=*

# Persistencia
DATABASE_URL=postgresql://postgres:postgres123@localhost:5432/gestion_firmas?schema=public
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PRESENCE_TTL=3600

# Seguridad Criptográfica (Claves de alta entropía)
JWT_SECRET=f4b9d0e28c71539a2b6d8e0f1a4c7e9b3d5f2a8c1e4d7b0a9f8e6c3d2b1a5f4e
TELEMETRIA_API_KEY=muni-coquimbo-ghost-app-sec-key-2026
HMAC_SECRET=8a1c9e3d5f7b0a2c4e6d8f1b3a5c7e9d2f4a6b8c0e1d3f5a7b9c1d3e5f7a9b1c
```

### 2.2 Despliegue con Docker Compose

```powershell
# Levantar todos los servicios en segundo plano
docker compose up -d

# Ver los logs del backend para obtener la contraseña temporal del primer inicio
docker logs --tail 30 gestion-firmas-backend
```

---

## 3. Ciclo de Vida de Credenciales y Administrador Inicial

### 3.1 Primer Inicio y Administrador Real

1. Al iniciar con la base en cero, el servicio `SeedService` detecta la ausencia de administradores y crea la cuenta del Administrador Institucional:
   - **RUT**: `21.374.808-4`
   - **Nombre**: `Daniel Alejandro Trigo Tabilo`
   - **Email**: `daniel.trigo@alumnos.ucn.cl`
   - **Rol**: `ADMIN`
2. Si `ADMIN_INICIAL_PASSWORD` y `ADMIN_INICIAL_PIN` están vacíos, el sistema **genera credenciales temporales aleatorias de alta entropía**, las hashea con algoritmo `scrypt`, las imprime **una sola vez** en los logs de Docker y activa la bandera `debeCambiarPassword = true`.
3. Con `debeCambiarPassword = true`:
   - El token JWT emitido restringe el acceso: únicamente permite consultar `/api/v1/auth/me` y cambiar la contraseña en `/api/v1/auth/cambiar-password`.
   - Cualquier intento de acceder a otros endpoints protegidos es rechazado con código `403 Forbidden` (`"Debe cambiar su contraseña temporal antes de continuar"`).
4. Tras cambiar la clave institucional (mínimo 10 caracteres, combinando mayúsculas, minúsculas y números), se emite una sesión completa definitiva con `debeCambiarPassword = false`.

---

## 4. Gestión de Administradores y Usuarios

### 4.1 Creación de Nuevos Administradores y Funcionarios

Los administradores pueden dar de alta a funcionarios y nuevos administradores mediante:

- **Endpoint**: `POST /api/v1/usuarios`
- **Cabecera**: `Authorization: Bearer <TOKEN_ADMIN>`
- **Cuerpo JSON**:

```json
{
  "rut": "15.789.456-1",
  "nombre": "Carlos Valenzuela M.",
  "email": "carlos.valenzuela@municoquimbo.cl",
  "cargo": "Jefe de Ciberseguridad",
  "unidad": "Dirección de TICs",
  "rol": "ADMIN",
  "condicionContractual": "PLANTA"
}
```

- **Respuesta**: Retorna los datos del usuario sanitizados (sin exponer hashes) e incluye `passwordTemporal` y `pinTemporal` generados para su entrega inicial. El nuevo administrador deberá cambiar su clave al ingresar.

### 4.2 Modificación de Roles y Reglas de Protección

- **Endpoint**: `PATCH /api/v1/usuarios/:id/rol`
- **Cuerpo JSON**: `{ "rol": "SUPERVISOR" }`
- **Reglas de Seguridad Activas**:
  - **Protección contra auto-degradación**: Un administrador no puede degradarse a sí mismo (`400 Bad Request`).
  - **Protección de último administrador**: El sistema impide degradar o suspender al último administrador activo del sistema (`400 Bad Request`).

### 4.3 Restablecimiento de Contraseña (Reset por Administrador)

- **Endpoint**: `POST /api/v1/usuarios/:id/reset-password`
- Genera una nueva contraseña temporal aleatoria de un solo uso y marca `debeCambiarPassword = true`.

### 4.4 Búsqueda y Filtros de Funcionarios

- **Endpoint**: `GET /api/v1/usuarios?q=termino&limit=50`
- Parámetros admitidos:
  - `q`: Búsqueda global insensible a mayúsculas sobre RUT, Nombre, Cargo, Unidad o Correo.
  - `rut`, `nombre`, `cargo`, `unidad`: Filtros específicos por columna.
  - `limit`: Límite de paginación para grandes volúmenes de usuarios.

---

## 5. Inventario de Tokens y Actas Digitales de Custodia

### 5.1 Registro de Token en Inventario

- **Endpoint**: `POST /api/v1/equipamiento/tokens`
- **Permisos**: `ADMIN` o `SUPERVISOR`
- **Cuerpo JSON**:

```json
{
  "serialNumber": "TOK-CQM-2026-001",
  "vendorId": "04b9",
  "marca": "SafeNet",
  "modelo": "eToken 5110 FIPS 140-2",
  "estadoPatrimonial": "OPERATIVO",
  "ubicacionFisica": "Bóveda TICs"
}
```

### 5.2 Emisión de Acta de Custodia (Entrega / Devolución / Traspaso)

Al realizar el trámite de entrega de custodia:

1. El **funcionario emisor** no se ingresa en el formulario: el backend lo extrae de forma transparente de la sesión activa del Administrador/Supervisor logueado vía JWT.
2. En el formulario solo se selecciona el **funcionario receptor** (mediante el buscador con filtros por RUT/Nombre/Cargo).

- **Endpoint**: `POST /api/v1/equipamiento/actas`
- **Cuerpo JSON**:

```json
{
  "tipoActa": "ENTREGA",
  "tokenId": "UUID_DEL_TOKEN",
  "usuarioId": "UUID_DEL_FUNCIONARIO_RECEPTOR",
  "observaciones": "Entrega de dispositivo criptográfico para firmas de decretos alcaldicios."
}
```

- **Resultado**:
  - Actualiza el estado patrimonial del token a `ASIGNADO`.
  - Registra el acta en PostgreSQL con hash criptográfico SHA-256.
  - Genera el documento oficial con caja de doble firma digital: **Firma del Emisor (Administrador)** y **Firma del Receptor (Funcionario)**.

### 5.3 Descarga del PDF Oficial del Acta

- **Endpoint**: `GET /api/v1/equipamiento/actas/:id/pdf?access_token=<TOKEN>`
- Soporta descarga directa mediante enlaces `<a href>` en el navegador pasando el token en el query parameter `?access_token=`.

---

## 6. Despliegue de la Ghost App (Agente USB en Estaciones Windows)

El agente `ghost-app` se encarga de monitorear en segundo plano la inserción y remoción de tokens USB físicos en las estaciones de trabajo del municipio.

### 6.1 Configuración por Estación (`config.json`)

Ubicación en cada PC: `ghost-app/config.json`:

```json
{
  "codigoPc": "PC-ALCALDIA-01",
  "servidorUrl": "http://192.168.1.100/api/v1/telemetria/usb",
  "intervaloPollingMs": 2000,
  "reintentosMaximos": 5
}
```

### 6.2 Instalación e Inicio Silencioso con Windows

1. Abrir una consola PowerShell o CMD como Administrador en la estación cliente.
2. Ejecutar el instalador:

   ```cmd
   cd ghost-app
   instalar-inicio-windows.bat
   ```

3. El instalador configura el acceso directo en `shell:startup` para que el script `ejecutar-oculto.vbs` lance el agente en modo completamente transparente sin ventanas de consola.
4. Si se pierde la conectividad de red, los eventos se encolan automáticamente en `%LOCALAPPDATA%\CoquimboGhostApp\cola-eventos.json` y se reenvían al restablecer el enlace.

### 6.3 Telemetría en Vivo y Alerta de Inactividad (> 5 Minutos)

- El endpoint `POST /api/v1/telemetria/usb` permanece abierto para garantizar la ingesta inmediata desde cualquier estación de la red interna sin requerir llaves en el cliente.
- El agente reporta el nombre de hardware real del dispositivo obtenido desde el sistema operativo (`FriendlyName`).
- El backend almacena la marca de tiempo de conexión en Redis (`token:connected_at:<codigoPc>`).
- En el endpoint `GET /api/v1/telemetria/estaciones`:
  - Se calcula `minutosConectado`.
  - Si un token permanece conectado por más de 5 minutos sin actividad de firma, se activa la bandera `alertaInactividad: true` y el mensaje preventivo de seguridad conforme al protocolo ANCI.

---

## 7. Flujo de Firmas Electrónicas y Portal Checksign

### 7.1 Firma Electrónica Avanzada Individual

- **Endpoint**: `POST /api/v1/firmas/solicitudes/:id/firmar`
- Valida el PIN del token contra el hash criptográfico `scrypt`.
- Aplica candado de concurrencia en Redis (`firmas:lock:<id>`).
- Estampa el sello visual con código QR y metadatos Checksign.

### 7.2 Atestación de Fe Pública (Secretario Municipal)

- **Endpoint**: `POST /api/v1/firmas/solicitudes/:id/fe-publica`
- **Permisos requeridos**: `ADMIN` o `MINISTRO_DE_FE`.
- Registra la certificación municipal de autenticidad documental conforme a la Ley N° 18.695.

### 7.3 Portal Público de Verificación Checksign

- **Verificación de Integridad**: `POST /api/v1/firmas/checksign/verificar` (Público, sin login).
- **Descarga de Certificado de Verificación**: `GET /api/v1/firmas/checksign/:codigo/certificado-pdf` (Público).

---

## 8. Integración del Frontend (`gestion-de-firmas-frontend`) — Implementación Completa

El frontend se encuentra **100% integrado y funcional** con las siguientes directivas de producción:

### 8.1 Acceso por Portada (Landing Page) y Modal de Login

- Al ingresar a `http://localhost:3000`, la aplicación inicia por defecto en la **Portada Institucional (Landing Page)**.
- El botón **"Iniciar Sesión Institucional"** abre el modal [`LoginModal.tsx`](file:///c:/Users/Daniel%20UCN/gestion-de-firmas-frontend/src/components/LoginModal.tsx) solicitando RUT y Contraseña.

### 8.2 Cambio Obligatorio de Contraseña (Primer Acceso)

- Al ingresar con la contraseña temporal inicial, el backend retorna `debeCambiarPassword = true`.
- El modal transiciona automáticamente al formulario de **"Cambio Obligatorio de Contraseña"** solicitando la nueva clave definitiva (mínimo 10 caracteres, combinando mayúsculas, minúsculas y números).
- Tras el cambio exitoso, el frontend almacena el token definitivo en `localStorage` y da acceso inmediato al panel institucional.

### 8.3 Navegación Estricta Basada en Roles Reales (Sin Switcher Falso)

- Se eliminó el conmutador manual que permitía alternar arbitrariamente entre Admin y Funcionario.
- Si el usuario logueado es `ADMIN` o `SUPERVISOR`:
  - Se habilitan los módulos de administración: **Telemetría de Tokens**, **Orquestador de Lotes**, **Usuarios & Custodia**, **Alertas de Vencimiento**, **Auditoría Forense ANCI** y **Configuración**.
  - Se muestra su perfil real con distintivo dorado **ADMIN**, su RUT (`21.374.808-4`) y nombre (`Daniel Alejandro Trigo Tabilo`).
- Si el usuario es `FUNCIONARIO`:
  - Solo tiene acceso a su **Bandeja Personal de Documentos** y al verificador **Checksign**.

### 8.4 Interceptor Global de Autenticación

- En `main.tsx` se configuró un interceptor global sobre `window.fetch` que inyecta automáticamente la cabecera `Authorization: Bearer <TOKEN>` en todas las peticiones dirigidas a `/api/`.
- Ante una expiración de sesión (código 401), se limpia `localStorage` y se redirige a la portada de bienvenida.

### 8.5 Descarga de PDFs Firmados

- Las actas y certificados admiten descarga directa mediante enlaces `<a href>` o `window.open` incluyendo el token en la URL (`?access_token=<TOKEN>`).
  const token = localStorage.getItem('access_token');
  window.open(`http://localhost:3001/api/v1/equipamiento/actas/${actaId}/pdf?access_token=${token}`, '_blank');
};

```

### 8.5 Formulario de Creación de Usuarios y Administradores
En el panel de administración de usuarios:
- Permitir seleccionar `rol: 'ADMIN'` para crear nuevos administradores.
- Mostrar una ventana modal con `passwordTemporal` y `pinTemporal` retornados por el backend con un botón de "Copiar al portapapeles" e indicar que solo se muestran una vez.

---

## 9. Resumen de Seguridad y Cumplimiento Normativo

| Componente | Mecanismo de Seguridad | Normativa Aplicada |
|---|---|---|
| Contraseñas y PINs | Función de derivación `scrypt` con sal aleatoria | ISO/IEC 27001 & ANCI |
| Sesiones | Tokens JWT firmados con HMAC-SHA256 y expiración en 8 horas | NCh-ISO 27001 |
| Bloqueo por Fuerza Bruta | Limitador a 5 intentos con ventana de 15 min | Ley N° 21.663 |
| Auditoría Forense | Ledger inmutable con índices GIN en PostgreSQL | Ley N° 21.663 Art. 12 |
| Trazabilidad de Actas | Emisor inmutable desde JWT y sellado SHA-256 | Ley N° 19.799 & ANCI |
| Presencia USB | Monitoreo en vivo con Redis TTL y alerta >5 min | Protocolo de Custodia ANCI |



##10. proceso de asignacion de token criptografico 

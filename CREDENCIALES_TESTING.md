# Credenciales y Configuración Institucional (Producción & Pruebas)
**Ilustre Municipalidad de Coquimbo — Sistema de Gestión de Firmas Electrónicas y Telemetría de Tokens USB**  
*Cumplimiento Normativo: Ley N° 19.799 (FEA), Ley N° 21.180 (Transformación Digital), Ley N° 21.663 (ANCI) e ISO/IEC 27001.*

---

## 1. Administrador Inicial Institucional (Base Limpia)

La base de datos se encuentra inicializada en **Estado Cero**, sin datos de prueba falsos, cosméticos ni cuentas de relleno.

### Datos del Administrador Institucional:
- **RUT:** `21.374.808-4`
- **Nombre:** `Daniel Alejandro Trigo Tabilo`
- **Email:** `daniel.trigo@alumnos.ucn.cl`
- **Cargo:** `Administrador General de Sistemas`
- **Unidad:** `Dirección de TICs`
- **Rol:** `ADMIN` (Acceso irrestricto para gestión de usuarios, roles, inventario y actas)
- **Contraseña:** Generada aleatoriamente al inicializar el servicio (visible en los logs del backend) y protegida mediante hashing con sal aleatoria (`scrypt`).
- **Política de Primer Acceso:** En el primer inicio de sesión se exige el cambio de contraseña inmediato mediante `POST /api/v1/auth/cambiar-password`.

---

## 2. Usuario Funcionario Institucional (Pruebas de Rol FUNCIONARIO / RBAC)

Para validar la segmentación de accesos por roles (RBAC) y la vista simplificada de funcionarios:

### Datos del Funcionario:
- **RUT:** `16.892.415-3`
- **Nombre:** `Juan Pérez González`
- **Email:** `juan.perez@municoquimbo.cl`
- **Cargo:** `Analista de Gestión Documental`
- **Unidad:** `Dirección de Tránsito y Transporte Público`
- **Rol:** `FUNCIONARIO`
- **Contraseña:** `Funcionario2026!`
- **PIN del Token:** `1234`
- **Vistas autorizadas:**
  - `Mis Documentos` (Bandeja personal de decretos, oficios y solicitudes asignadas para firma electrónica).
  - `Verificar Documento` (Validación de autenticidad de firmas y certificados).
  - `Portada de Bienvenida` (Información institucional y acceso público).
- **Vistas restringidas (Exclusivas de ADMIN / SUPERVISOR):**
  - Dispositivos Conectados (Telemetría de hardware USB en tiempo real)
  - Firma Masiva (Lotes de decretos)
  - Funcionarios y Custodia (Asignación y entrega de tokens)
  - Alertas y Vencimientos
  - Historial de Actividad (Auditoría)
  - Configuración del Sistema

---

## 3. Creación de Nuevos Administradores

Cualquier usuario con rol `ADMIN` puede habilitar nuevos administradores a través de la API institucional:
- **Ruta:** `POST /api/v1/usuarios`
- **Cabecera requerida:** `Authorization: Bearer <TOKEN_ADMIN>`
- **Ejemplo de cuerpo:**
```json
{
  "rut": "15.789.456-1",
  "nombre": "Carlos Valenzuela",
  "email": "carlos.valenzuela@municoquimbo.cl",
  "cargo": "Jefe de Seguridad de la Información",
  "unidad": "Dirección de TICs",
  "rol": "ADMIN",
  "condicionContractual": "PLANTA"
}
```
*Si no se especifica `password`, el sistema genera automáticamente una contraseña temporal y la retorna una sola vez en la respuesta para su entrega segura.*

---

## 3. Servicios de Infraestructura (Docker Compose)

| Servicio | Puerto Local | Usuario / Credencial | Propósito |
| :--- | :--- | :--- | :--- |
| **Nginx Gateway** | `http://localhost:80` | Proxy Inverso | Pasarela HTTP unificada y WebSocket |
| **Backend Core** | `http://localhost:3001` | Bearer JWT (HS256) | API REST y Swagger en `/api/docs` |
| **PostgreSQL 16** | `localhost:5432` | `postgres` | Persistencia relacional y Ledger de Auditoría GIN JSONB |
| **Redis 7** | `localhost:6379` | Integrado | Telemetría en vivo (TTL 3600s) y colas BullMQ |
| **MinIO S3** | `localhost:9000` / `9001` | `minioadmin` | Almacenamiento seguro de PDFs firmados y actas |

Para el detalle paso a paso de los flujos de trabajo, consultar [`FLUJO_DE_TRABAJO.md`](file:///c:/Users/Daniel%20UCN/gestion-de-firmas/FLUJO_DE_TRABAJO.md).

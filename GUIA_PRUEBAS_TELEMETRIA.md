# Guía de Pruebas de Telemetría de Tokens Criptográficos USB
**Ilustre Municipalidad de Coquimbo — Sistema de Gestión de Firmas y Telemetría de Tokens**  
*Cumplimiento Normativo: Ley N° 21.663 (ANCI), Ley N° 19.799 (FEA) e ISO/IEC 27001.*

---

## 1. Arquitectura del Flujo de Telemetría

El ciclo de validación de telemetría de hardware criptográfico sigue el siguiente flujo de extremo a extremo:

```
[Token USB Criptográfico]
          │ (Conexión / Desconexión física en puerto USB)
          ▼
[Agente Ghost App / Simulador] (Electron / Node.js)
          │
          │ HTTP POST /api/v1/telemetria/usb (Payload JSON)
          ▼
[Backend Core NestJS] (:3001)
     ├── 1. Redis Cache (:6379) ─── SET pc:<codigoPc> <ESTADO> EX 3600
     ├── 2. PostgreSQL (:5432)  ─── Upsert en estaciones_trabajo + Insert en telemetria_eventos (JSONB)
     └── 3. WebSocket Gateway   ─── server.emit("estado_pc_actualizado", payload)
          │
          ▼
[Frontend Dashboard Supervisores]
     Recepción instantánea vía Socket.io y actualización reactiva de tarjetas y semáforos.
```

---

## 2. Métodos de Prueba

### Método 1: Prueba Rápida con el Simulador Multi-Estación

El simulador oficial se encuentra en [`ghost-app/simulator.js`](file:///C:/Users/Daniel%20UCN/gestion-de-firmas/ghost-app/simulator.js).

1. Abre el Frontend en el navegador en la sección **Telemetría de Tokens** (`http://localhost:5173` o `http://localhost:3000`).
2. Abre una terminal de PowerShell y corre el simulador:
   ```powershell
   node ghost-app/simulator.js
   # O alternativamente desde la carpeta ghost-app:
   # cd ghost-app && npm run simulate
   ```
3. Verifica que en pantalla las estaciones `PC-SECMUN-01`, `PC-DOM-05` y la estación local (`os.hostname()`) actualicen su estado inmediatamente a través de WebSockets sin recargar la página.

---

### Método 2: Inyección Manual de Eventos HTTP (PowerShell)

#### A. Inyectar Token Conectado en Reposo (`CONECTADO`):
```powershell
# Ejemplo con el nombre tal como lo registra el Sistema Operativo (FriendlyName / DeviceName):
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/usb" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{
  "codigoPc": "PC-DOM-05",
  "estadoHardware": "CONECTADO",
  "serialNumber": "SN-0529-D453B70C2CF7",
  "vendorId": "0x0529",
  "marca": "SafeNet Inc.",
  "modelo": "SafeNet eToken 5110",
  "ipAsignada": "10.20.2.45",
  "dependenciaFisica": "Dirección de Obras Municipales",
  "metadatos": {
    "osDeviceName": "SafeNet eToken 5110",
    "driver": "SafeNet Authentication Client"
  }
}'
```

#### B. Simular Operación de Firma Activa (`FIRMANDO`):
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/usb" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{
  "codigoPc": "PC-DOM-05",
  "estadoHardware": "FIRMANDO",
  "serialNumber": "SN-SAF-98214",
  "vendorId": "0x0529"
}'
```

#### C. Simular Extracción Física del Token (`DESCONECTADO`):
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/usb" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{
  "codigoPc": "PC-DOM-05",
  "estadoHardware": "DESCONECTADO"
}'
```

---

### Método 3: Verificación de Persistencia, Deduplicación y Alerta de Inactividad

> [!IMPORTANT]
> **Política de Deduplicación y Monitoreo de Seguridad:**
> 1. **Registro Único por Transición**: Al desconectarse o conectarse un token, el evento se registra **una sola vez** en la base de datos forense (`telemetria_eventos`). Mientras la ranura permanezca vacía esperando conexión, los sondeos periódicos no se apilan ni saturan la bitácora.
> 2. **Alerta de Inactividad (> 5 minutos)**: El sistema lleva la marca de tiempo de conexión en Redis. Si un token permanece conectado por más de 5 minutos sin realizar firmas, el sistema emite automáticamente una alerta de seguridad (`alertaInactividad: true`).

#### 1. Consultar estado consolidado en vivo con alertas de inactividad:
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/estaciones" | Select-Object codigoPc, estadoEnVivo, minutosConectado, alertaInactividad, alertaMensaje | Format-Table -AutoSize
```

#### 2. Consultar bitácora forense de auditoría ANCI (solo eventos únicos):
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/eventos-recientes" | Select-Object codigoPc, evento, timestamp | Format-Table -AutoSize
```

#### 3. Verificar estado en Redis y clave de tiempo de conexión:
```powershell
docker exec -it gestion-firmas-redis redis-cli GET "pc:status:PC-DOM-05"
docker exec -it gestion-firmas-redis redis-cli GET "token:connected_at:PC-DOM-05"
```

---

### Método 4: Ejecución del Agente Silencioso Headless Real

Para estaciones de trabajo con tokens físicos USB conectados:
```powershell
node ghost-app/main.js
# O usando el script directo:
# .\iniciar-agente.bat
```
- Lee automáticamente el `os.hostname()` de la máquina.
- Escanea el bus PnP/WebHID buscando Vendor IDs autorizados (`0x0529` SafeNet, `0x0DC3` Athena, `0x096E` Feitian).
- Despacha los eventos hacia `POST /api/v1/telemetria/usb`. Si la red cae, activa la cola local con política de **Exponential Backoff**.

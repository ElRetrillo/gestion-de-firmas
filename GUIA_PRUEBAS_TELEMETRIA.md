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
   node "C:\Users\Daniel UCN\gestion-de-firmas\ghost-app\simulator.js"
   ```
3. Verifica que en pantalla las estaciones `PC-SECMUN-01`, `PC-DOM-05` y la estación local (`os.hostname()`) actualicen su estado inmediatamente a través de WebSockets sin recargar la página.

---

### Método 2: Inyección Manual de Eventos HTTP (PowerShell)

#### A. Inyectar Token Conectado en Reposo (`CONECTADO`):
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/usb" -Method POST -Headers @{ "Content-Type" = "application/json" } -Body '{
  "codigoPc": "PC-DOM-05",
  "estadoHardware": "CONECTADO",
  "serialNumber": "SN-SAF-98214",
  "vendorId": "0x0529",
  "marca": "Thales / SafeNet",
  "modelo": "eToken 5110 CC (FIPS 140-2 L3)",
  "ipAsignada": "10.20.2.45",
  "dependenciaFisica": "Dirección de Obras Municipales",
  "metadatos": {
    "slot": 1,
    "fipsCertified": true,
    "driver": "SafeNet Authentication Client 10.8"
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

### Método 3: Verificación de Persistencia en Base de Datos y Redis

#### 1. Consultar estado consolidado en vivo (Redis + PostgreSQL):
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/estaciones" | ConvertTo-Json -Depth 3
```

#### 2. Consultar bitácora forense de auditoría ANCI:
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/v1/telemetria/eventos-recientes" | ConvertTo-Json -Depth 3
```

#### 3. Verificar clave efímera y TTL en Redis (3600 segundos):
```powershell
docker exec -it gestion-firmas-redis redis-cli GET "pc:PC-DOM-05"
docker exec -it gestion-firmas-redis redis-cli TTL "pc:PC-DOM-05"
```

---

### Método 4: Ejecución del Agente Silencioso Headless Real

Para estaciones de trabajo con tokens físicos USB conectados:
```powershell
node "C:\Users\Daniel UCN\gestion-de-firmas\ghost-app\main.js"
```
- Lee automáticamente el `os.hostname()` de la máquina.
- Escanea el bus PnP/WebHID buscando Vendor IDs autorizados (`0x0529` SafeNet, `0x0DC3` Athena, `0x096E` Feitian).
- Despacha los eventos hacia `POST /api/v1/telemetria/usb`. Si la red cae, activa la cola local con política de **Exponential Backoff**.

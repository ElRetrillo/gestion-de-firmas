/**
 * AGENTE LOCAL SILENCIOSO (ELECTRON GHOST APP)
 * Ilustre Municipalidad de Coquimbo - Arquitectura v2.0
 *
 * Responsabilidades:
 * 1. Ejecución Headless (sin ventana visible en el escritorio del funcionario).
 * 2. Identificación automática de la estación de trabajo vía os.hostname().
 * 3. Detección de eventos físicos USB / WebHID / SmartCard de Tokens Criptográficos
 *    (SafeNet eToken 5110 CC, Athena IDProtect, Feitian ePass2003, Gemalto IDPrime).
 * 4. Despacho de telemetría hacia POST /api/v1/telemetria/usb con cola de resiliencia
 *    local y política de reintento Exponential Backoff ante cortes de red.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let electronApp = null;
let BrowserWindow = null;
try {
  const electron = require('electron');
  electronApp = electron.app;
  BrowserWindow = electron.BrowserWindow;
} catch {
  // Permite ejecución en modo servicio Node.js puro si Electron no está presente en el host
}

const API_BASE_URL = process.env.TELEMETRIA_API_URL || 'http://localhost:3001/api/v1/telemetria/usb';
const HOSTNAME = process.env.CODIGO_PC_OVERRIDE || os.hostname().toUpperCase();
const DEPENDENCIA_FISICA = process.env.DEPENDENCIA_FISICA || 'Red Interna Municipal - Coquimbo';
const POLL_INTERVAL_MS = Number(process.env.USB_POLL_INTERVAL_MS || 2000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.USB_HEARTBEAT_INTERVAL_MS || 45000);
const OFFLINE_QUEUE_FILE = path.join(os.tmpdir(), 'coquimbo-ghost-telemetry-queue.json');

// Catálogo de Vendor IDs oficiales de Tokens Criptográficos Acreditados (Ley N° 19.799)
const KNOWN_CRYPTO_VENDORS = {
  '0529': { marca: 'Thales / SafeNet', modelo: 'eToken 5110 CC (FIPS 140-2 L3)' },
  '04B9': { marca: 'SafeNet / Rainbow', modelo: 'iKey / eToken Pro USB' },
  '0DC3': { marca: 'Athena Smartcard', modelo: 'IDProtect Key USB v2' },
  '076B': { marca: 'Athena / OmniKey', modelo: 'ASECard Crypto USB' },
  '096E': { marca: 'Feitian Technologies', modelo: 'ePass2003-Auto FIPS' },
  '08E6': { marca: 'Thales / Gemalto', modelo: 'IDPrime / Ezio Token USB (FIPS 140-2)' },
  '04E6': { marca: 'Identiv / SCM', modelo: 'uTrust SmartCard Token' },
  '0A89': { marca: 'ActivIdentity / HID', modelo: 'ActivKey USB Token' },
  '1050': { marca: 'Yubico', modelo: 'YubiKey FIPS Series' },
  '20A0': { marca: 'Nitrokey', modelo: 'Nitrokey HSM / Pro USB' },
};

// Cola en memoria y disco para resiliencia con Exponential Backoff
let pendingQueue = [];
let retryAttempt = 0;
let retryTimer = null;
let lastKnownState = null;
let lastKnownSerial = null;
let lastKnownToken = null;
let lastHeartbeatAt = 0;
let isScanning = false;

function loadOfflineQueue() {
  try {
    if (fs.existsSync(OFFLINE_QUEUE_FILE)) {
      const raw = fs.readFileSync(OFFLINE_QUEUE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Conservar solo eventos de cambio real de estado recientes para evitar re-emitir estados obsoletos
      if (Array.isArray(parsed)) {
        pendingQueue = parsed.filter((item) => item && item.metadatos && item.metadatos.stateChanged === true).slice(-10);
      }
    }
  } catch {
    pendingQueue = [];
  }
}

function saveOfflineQueue() {
  try {
    fs.writeFileSync(OFFLINE_QUEUE_FILE, JSON.stringify(pendingQueue.slice(-50), null, 2), 'utf8');
  } catch {
    // Ignorar errores de escritura en tmp
  }
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '10.10.12.100';
}

/**
 * Envía el payload al Backend NestJS con política de Exponential Backoff
 * Base delay: 2s -> 4s -> 8s -> 16s -> 32s -> max 60s
 */
async function sendTelemetryWithBackoff(payload) {
  // Si hay un cambio de estado real, descartar heartbeats antiguos en cola de la misma estación
  if (payload.metadatos && payload.metadatos.stateChanged) {
    pendingQueue = pendingQueue.filter((item) => item.codigoPc !== payload.codigoPc || item.metadatos?.stateChanged);
  }
  pendingQueue.push(payload);
  saveOfflineQueue();
  await flushQueue();
}

async function flushQueue() {
  if (pendingQueue.length === 0) return;

  while (pendingQueue.length > 0) {
    const item = pendingQueue[0];
    try {
      const response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ghost-Agent-Version': '2.1.0-headless',
          'X-Workstation-Hostname': HOSTNAME,
        },
        body: JSON.stringify(item),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Éxito: remover de la cola y reiniciar contador de backoff
      pendingQueue.shift();
      saveOfflineQueue();
      retryAttempt = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const tag = item.metadatos?.isHeartbeat ? 'HEARTBEAT' : 'EVENTO';
      console.log(
        `[GhostAgent] [${tag}] Telemetría sincronizada -> PC=${item.codigoPc} Estado=${item.estadoHardware}${
          item.serialNumber ? ` S/N=${item.serialNumber}` : ''
        }`,
      );
    } catch (error) {
      retryAttempt += 1;
      const delayMs = Math.min(60000, Math.pow(2, retryAttempt) * 1000 + Math.floor(Math.random() * 500));
      console.warn(
        `[GhostAgent] Servidor central no disponible (${error.message}). Eventos en cola local: ${pendingQueue.length}. Reintento #${retryAttempt} en ${Math.round(delayMs / 1000)}s (Exponential Backoff)...`,
      );

      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          flushQueue();
        }, delayMs);
      }
      break;
    }
  }
}

/**
 * Inspecciona el bus USB / SmartCard en Windows mediante WMI/PnP para detectar Tokens PKCS#11 físicos reales.
 * Excluye explícitamente buses virtuales de software como SWD\SCDEVICEENUMBUS\0 ("Smart Card Device Enumeration Bus").
 */
function scanWindowsUsbTokens() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    const psCmd = `powershell -NoProfile -NonInteractive -Command "Get-PnpDevice -PresentOnly | Where-Object { $_.Status -eq 'OK' -and $_.Class -notin @('SoftwareDevice','System','Net','Bluetooth','Media','AudioEndpoint') -and $_.InstanceId -notmatch '^(SWD|ROOT|ACPI|PCI|BTH|UMB|STORAGE|DISPLAY)\\\\' -and ($_.InstanceId -match 'VID_(0529|0DC3|096E|08E6|04B9|076B|04E6|0A89|1050|20A0)' -or $_.Class -in @('SmartCardReader','SmartCard','SmartCardFilter') -or ($_.InstanceId -match '^USB\\\\' -and $_.FriendlyName -match 'eToken|SafeNet|IDProtect|ePass|IDPrime|Ezio|Gemalto|Thales|Athena|Feitian|YubiKey|Nitrokey|Token')) } | Select-Object Status,Class,FriendlyName,InstanceId | ConvertTo-Json -Compress"`;

    exec(psCmd, { timeout: 4500 }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const devices = Array.isArray(parsed) ? parsed : [parsed];

        // Filtrar cualquier bus de software o enumerador virtual
        const validDevices = devices.filter((d) => {
          if (!d || !d.InstanceId) return false;
          const id = String(d.InstanceId).toUpperCase();
          const cls = String(d.Class || '').toUpperCase();
          const name = String(d.FriendlyName || '').toUpperCase();
          if (cls === 'SOFTWAREDEVICE' || id.startsWith('SWD\\') || id.startsWith('ROOT\\')) {
            return false;
          }
          if (name.includes('ENUMERATION BUS') || name.includes('VIRTUAL')) {
            return false;
          }
          return String(d.Status || '').toUpperCase() === 'OK';
        });

        if (validDevices.length === 0) {
          resolve(null);
          return;
        }

        // Priorizar el dispositivo que exponga explícitamente el bus USB con VID_XXXX sobre filtros SCFILTER
        validDevices.sort((a, b) => {
          const aHasVid = /VID_[0-9A-F]{4}/i.test(String(a.InstanceId)) ? 0 : 1;
          const bHasVid = /VID_[0-9A-F]{4}/i.test(String(b.InstanceId)) ? 0 : 1;
          return aHasVid - bHasVid;
        });

        const chosen = validDevices[0];
        const instanceIdStr = String(chosen.InstanceId || '');
        const vidMatch = instanceIdStr.match(/VID_([0-9A-F]{4})/i);
        const vid = vidMatch ? vidMatch[1].toUpperCase() : '08E6';

        // Extraer número de serie real de la instancia USB si está disponible (ej: USB\VID_08E6&PID_34CF\D453B70C2CF7)
        const parts = instanceIdStr.split('\\');
        const rawInstanceSerial = parts.length >= 3 ? parts[2] : '';
        const cleanSerial =
          rawInstanceSerial && !rawInstanceSerial.includes('&')
            ? `SN-${vid}-${rawInstanceSerial.replace(/[^A-Z0-9-]/gi, '').toUpperCase()}`
            : `SN-WIN-${HOSTNAME}-${vid}`;

        const vendorMeta = KNOWN_CRYPTO_VENDORS[vid] || {
          marca: 'Thales / SafeNet',
          modelo: chosen.FriendlyName || 'USB Cryptographic Token',
        };

        const friendly = String(chosen.FriendlyName || '').trim();
        const modeloFinal =
          friendly && !friendly.toLowerCase().includes('filtro') && !friendly.toLowerCase().includes('filter')
            ? `${vendorMeta.modelo.split(' (')[0]} (${friendly})`
            : vendorMeta.modelo;

        resolve({
          vendorId: `0x${vid}`,
          serialNumber: cleanSerial,
          marca: vendorMeta.marca,
          modelo: modeloFinal,
          instanceId: instanceIdStr,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

async function monitorUsbLoop() {
  if (isScanning) return;
  isScanning = true;

  try {
    const detectedToken = await scanWindowsUsbTokens();
    const currentState = detectedToken ? 'CONECTADO' : 'DESCONECTADO';
    const currentSerial = detectedToken ? detectedToken.serialNumber : null;

    const stateChanged =
      currentState !== lastKnownState ||
      (currentState === 'CONECTADO' && currentSerial !== lastKnownSerial);

    const now = Date.now();
    const heartbeatDue = now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS;

    // Solo emitir cuando cambia el estado físico (inserción/extracción) o cuando toca heartbeat de presencia
    if (!stateChanged && !heartbeatDue) {
      return;
    }

    if (stateChanged) {
      if (currentState === 'CONECTADO' && detectedToken) {
        console.log(
          `[GhostAgent] [USB INSERTADO] Token detectado: ${detectedToken.marca} - ${detectedToken.modelo} (S/N: ${detectedToken.serialNumber}, VID: ${detectedToken.vendorId})`,
        );
      } else {
        console.log(
          `[GhostAgent] [USB EXTRAÍDO] Ranura libre en estación ${HOSTNAME}${
            lastKnownToken ? ` (Token removido: ${lastKnownToken.serialNumber})` : ''
          }`,
        );
      }
    }

    const payload = {
      codigoPc: HOSTNAME,
      estadoHardware: currentState,
      serialNumber: detectedToken ? detectedToken.serialNumber : undefined,
      vendorId: detectedToken ? detectedToken.vendorId : undefined,
      marca: detectedToken ? detectedToken.marca : undefined,
      modelo: detectedToken ? detectedToken.modelo : undefined,
      ipAsignada: getLocalIpAddress(),
      dependenciaFisica: DEPENDENCIA_FISICA,
      timestamp: new Date().toISOString(),
      metadatos: {
        osPlatform: `${os.type()} ${os.release()}`,
        hostname: os.hostname(),
        agentVersion: '2.1.0-headless',
        stateChanged,
        isHeartbeat: !stateChanged,
        previousSerialNumber: !detectedToken && lastKnownToken ? lastKnownToken.serialNumber : undefined,
      },
    };

    lastKnownState = currentState;
    lastKnownSerial = currentSerial;
    if (detectedToken) {
      lastKnownToken = detectedToken;
    }
    lastHeartbeatAt = now;

    await sendTelemetryWithBackoff(payload);
  } finally {
    isScanning = false;
  }
}

async function handleGracefulShutdown() {
  console.log(`\n[GhostAgent] Cerrando agente en ${HOSTNAME}. Notificando estado DESCONECTADO...`);
  try {
    await fetch(API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ghost-Agent-Version': '2.1.0-headless',
        'X-Workstation-Hostname': HOSTNAME,
      },
      body: JSON.stringify({
        codigoPc: HOSTNAME,
        estadoHardware: 'DESCONECTADO',
        ipAsignada: getLocalIpAddress(),
        dependenciaFisica: DEPENDENCIA_FISICA,
        timestamp: new Date().toISOString(),
        metadatos: {
          osPlatform: `${os.type()} ${os.release()}`,
          hostname: os.hostname(),
          agentVersion: '2.1.0-headless',
          stateChanged: true,
          isHeartbeat: false,
          reason: 'AGENT_SHUTDOWN',
          previousSerialNumber: lastKnownToken ? lastKnownToken.serialNumber : undefined,
        },
      }),
    });
  } catch {
    // Ignorar error al cerrar
  }
  process.exit(0);
}

function startHeadlessAgent() {
  console.log(`[GhostAgent] Iniciando Agente Silencioso v2.1 en estación: ${HOSTNAME}`);
  console.log(`[GhostAgent] Destino de Telemetría: ${API_BASE_URL}`);
  console.log(`[GhostAgent] Escaneo PnP/USB activo cada ${POLL_INTERVAL_MS}ms...`);
  loadOfflineQueue();
  monitorUsbLoop();
  setInterval(monitorUsbLoop, POLL_INTERVAL_MS);

  process.on('SIGINT', handleGracefulShutdown);
  process.on('SIGTERM', handleGracefulShutdown);
}

if (electronApp) {
  // Ocultar icono en Dock / Barra de tareas para operación Headless transparente
  if (electronApp.dock) {
    electronApp.dock.hide();
  }

  electronApp.whenReady().then(() => {
    const hiddenWin = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    // Habilitar permisos automáticos para WebHID en el contexto oculto
    hiddenWin.webContents.session.setDevicePermissionHandler(() => true);

    startHeadlessAgent();
  });

  electronApp.on('window-all-closed', (e) => {
    e.preventDefault(); // Mantener residente en segundo plano
  });
} else {
  startHeadlessAgent();
}

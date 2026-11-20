// Agente local silencioso de telemetría USB (Ghost App) - Headless Node.js / Electron

const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let electronApp = null;
let BrowserWindow = null;
let ipcMain = null;
try {
  const electron = require('electron');
  electronApp = electron.app;
  BrowserWindow = electron.BrowserWindow;
  ipcMain = electron.ipcMain;
} catch {
  // Ejecución en modo Node.js puro cuando Electron no está presente
}

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  let fileConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    console.warn('[GhostAgent] Advertencia al leer config.json:', err.message);
  }

  const apiUrl =
    process.env.TELEMETRIA_API_URL ||
    fileConfig.apiUrl ||
    'http://localhost:3001/api/v1/telemetria/usb';

  const apiKey =
    process.env.TELEMETRIA_API_KEY ||
    fileConfig.apiKey ||
    'CHANGE_ME_TELEMETRIA_API_KEY';

  const hostname =
    process.env.CODIGO_PC_OVERRIDE ||
    fileConfig.codigoPcOverride ||
    os.hostname().toUpperCase();

  const dependencia =
    process.env.DEPENDENCIA_FISICA ||
    fileConfig.dependenciaFisica ||
    'Red Interna Municipal - Coquimbo';

  const pollInterval = Number(
    process.env.USB_POLL_INTERVAL_MS || fileConfig.pollIntervalMs || 2000,
  );

  const heartbeatInterval = Number(
    process.env.USB_HEARTBEAT_INTERVAL_MS || fileConfig.heartbeatIntervalMs || 45000,
  );

  const appDataRoot = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  const queueDir = path.join(appDataRoot, 'CoquimboGhostApp');
  try {
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }
  } catch {}

  const queueFile = fs.existsSync(queueDir)
    ? path.join(queueDir, 'telemetry-queue.json')
    : path.join(os.tmpdir(), 'coquimbo-ghost-telemetry-queue.json');

  return {
    apiUrl,
    apiKey,
    hostname,
    dependencia,
    pollInterval,
    heartbeatInterval,
    queueFile,
  };
}

const CONFIG = loadConfig();
const API_BASE_URL = CONFIG.apiUrl;
const API_KEY = CONFIG.apiKey;
const HOSTNAME = CONFIG.hostname;
const DEPENDENCIA_FISICA = CONFIG.dependencia;
const POLL_INTERVAL_MS = CONFIG.pollInterval;
const HEARTBEAT_INTERVAL_MS = CONFIG.heartbeatInterval;
const OFFLINE_QUEUE_FILE = CONFIG.queueFile;

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
      const parsed = JSON.parse(fs.readFileSync(OFFLINE_QUEUE_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        pendingQueue = parsed
          .filter((item) => item && item.metadatos && item.metadatos.stateChanged === true)
          .slice(-10);
      }
    }
  } catch {
    pendingQueue = [];
  }
}

function saveOfflineQueue() {
  try {
    fs.writeFileSync(OFFLINE_QUEUE_FILE, JSON.stringify(pendingQueue.slice(-50), null, 2), 'utf8');
  } catch {}
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

async function sendTelemetryWithBackoff(payload) {
  if (payload.metadatos && payload.metadatos.stateChanged) {
    pendingQueue = pendingQueue.filter(
      (item) => item.codigoPc !== payload.codigoPc || item.metadatos?.stateChanged,
    );
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
          'X-Api-Key': API_KEY,
          'X-Ghost-Agent-Version': '2.1.0-headless',
          'X-Workstation-Hostname': HOSTNAME,
        },
        body: JSON.stringify(item),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      pendingQueue.shift();
      saveOfflineQueue();
      retryAttempt = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const tag = item.metadatos?.isHeartbeat ? 'HEARTBEAT' : 'EVENTO';
      console.log(
        `[GhostAgent] [${tag}] PC=${item.codigoPc} Estado=${item.estadoHardware}${
          item.serialNumber ? ` S/N=${item.serialNumber}` : ''
        }`,
      );
    } catch (error) {
      retryAttempt += 1;
      const delayMs = Math.min(60000, Math.pow(2, retryAttempt) * 1000 + Math.floor(Math.random() * 500));
      console.warn(
        `[GhostAgent] Servidor no disponible (${error.message}). Cola: ${pendingQueue.length}. Reintento #${retryAttempt} en ${Math.round(delayMs / 1000)}s.`,
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

        const validDevices = devices.filter((d) => {
          if (!d || !d.InstanceId) return false;
          const id = String(d.InstanceId).toUpperCase();
          const cls = String(d.Class || '').toUpperCase();
          const name = String(d.FriendlyName || '').toUpperCase();
          if (cls === 'SOFTWAREDEVICE' || id.startsWith('SWD\\') || id.startsWith('ROOT\\')) return false;
          if (name.includes('ENUMERATION BUS') || name.includes('VIRTUAL')) return false;
          return String(d.Status || '').toUpperCase() === 'OK';
        });

        if (validDevices.length === 0) {
          resolve(null);
          return;
        }

        validDevices.sort((a, b) => {
          const aHasVid = /VID_[0-9A-F]{4}/i.test(String(a.InstanceId)) ? 0 : 1;
          const bHasVid = /VID_[0-9A-F]{4}/i.test(String(b.InstanceId)) ? 0 : 1;
          return aHasVid - bHasVid;
        });

        const chosen = validDevices[0];
        const instanceIdStr = String(chosen.InstanceId || '');
        const vidMatch = instanceIdStr.match(/VID_([0-9A-F]{4})/i);
        const vid = vidMatch ? vidMatch[1].toUpperCase() : 'UNKNOWN';

        const parts = instanceIdStr.split('\\');
        const rawInstanceSerial = parts.length >= 3 ? parts[2] : '';
        const cleanSerial =
          rawInstanceSerial && !rawInstanceSerial.includes('&')
            ? `SN-${vid}-${rawInstanceSerial.replace(/[^A-Z0-9-]/gi, '').toUpperCase()}`
            : `SN-WIN-${HOSTNAME}-${vid}`;

        const osDeviceName = String(chosen.FriendlyName || chosen.Caption || chosen.Description || '').trim();
        const osManufacturer = String(chosen.Manufacturer || '').trim();
        const vendorMeta = KNOWN_CRYPTO_VENDORS[vid];

        const marcaFinal =
          osManufacturer && !osManufacturer.startsWith('(') && osManufacturer.toLowerCase() !== 'microsoft'
            ? osManufacturer
            : vendorMeta?.marca || 'Dispositivo Criptográfico PKCS#11';

        const modeloFinal = osDeviceName || vendorMeta?.modelo || 'Token Criptográfico USB';

        resolve({
          vendorId: vid !== 'UNKNOWN' ? `0x${vid}` : '0x0000',
          serialNumber: cleanSerial,
          marca: marcaFinal,
          modelo: modeloFinal,
          instanceId: instanceIdStr,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

function getTokenCertCachePath() {
  return path.join(path.dirname(OFFLINE_QUEUE_FILE), 'token-certs-cache.json');
}

function esNombreIdentificadorInvalido(nombre) {
  if (!nombre) return true;
  const s = String(nombre).trim();
  if (!s) return true;
  if (/^\{?[0-9a-f]{4,8}(-[0-9a-f]{4,12}){2,4}\}?$/i.test(s)) return true;
  if (/^(MS-Organization-Access|MS-Organization-P2P-Access|localhost|DESKTOP-|WIN-)/i.test(s)) return true;
  return false;
}

function obtenerCacheCertToken(serialNumber) {
  if (!serialNumber) return null;
  const key = String(serialNumber).toUpperCase();
  try {
    const cachePath = getTokenCertCachePath();
    if (fs.existsSync(cachePath)) {
      const map = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (map && map[key] && !esNombreIdentificadorInvalido(map[key].titularNombre)) {
        return map[key];
      }
    }
  } catch {}
  return null;
}

function guardarCacheCertToken(serialNumber, certMeta) {
  if (!serialNumber || !certMeta?.titularNombre || esNombreIdentificadorInvalido(certMeta.titularNombre)) return;
  const key = String(serialNumber).toUpperCase();
  try {
    const cachePath = getTokenCertCachePath();
    let map = {};
    if (fs.existsSync(cachePath)) {
      map = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
    map[key] = certMeta;
    fs.writeFileSync(cachePath, JSON.stringify(map, null, 2), 'utf8');
  } catch {}
}

function validarRutModulo11(rutRaw) {
  if (!rutRaw) return false;
  const clean = String(rutRaw).replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 8 || clean.length > 9) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const num = Number(body);
  if (!num || num < 1000000 || num >= 50000000) return false;
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const res = 11 - (sum % 11);
  const expected = res === 11 ? '0' : res === 10 ? 'K' : String(res);
  return dv === expected;
}

function listarCertificadosTokenWindows() {
  return new Promise((resolve) => {
    const ps = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $OutputEncoding = [System.Text.Encoding]::UTF8
      $certs = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey -eq $true } | ForEach-Object {
        $ascii = [System.Text.Encoding]::ASCII.GetString($_.RawData)
        $matchesRut = [regex]::Matches($ascii, '\\b([1-4]?\\d{6,7}-[0-9Kk])\\b') | ForEach-Object { $_.Value }
        $provider = ''
        try {
          if ($_.PrivateKey -and $_.PrivateKey.CspKeyContainerInfo) {
            $provider = [string]$_.PrivateKey.CspKeyContainerInfo.ProviderName
          }
        } catch {}
        [PSCustomObject]@{
          thumbprint = $_.Thumbprint
          subject = $_.Subject
          issuer = $_.Issuer
          serialNumber = $_.SerialNumber
          notBefore = $_.NotBefore.ToString('o')
          notAfter = $_.NotAfter.ToString('o')
          esExpirado = ($_.NotAfter -lt (Get-Date))
          rutsCandidatos = ($matchesRut -join ',')
          provider = $provider
        }
      }
      if ($certs) { $certs | ConvertTo-Json -Compress } else { '[]' }
    `;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { windowsHide: true, timeout: 10000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          const mapped = arr
            .map((c) => {
              const cnMatch = String(c.subject || '').match(/CN=([^,]+)/i);
              const cnClean = cnMatch ? cnMatch[1].trim() : c.subject;
              const candidatos = String(c.rutsCandidatos || '')
                .split(',')
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean);
              const rutValido = candidatos.find((r) => validarRutModulo11(r)) || null;
              const issuerStr = String(c.issuer || '');
              const providerStr = String(c.provider || '');
              const esFeaAcreditada = /E-Sign|ESign|Acepta|E-Cert|ECert|Paperless|TOC|Estado de Chile/i.test(
                issuerStr,
              );
              const esHardwareProvider = /eToken|SafeNet|Smart Card|SmartCard|Gemalto|Thales|Feitian|Athena|PKCS11/i.test(
                `${providerStr} ${issuerStr}`,
              );
              return {
                ...c,
                cn: cnClean,
                rut: rutValido,
                esFeaAcreditada,
                esHardwareProvider,
              };
            })
            .filter(
              (c) =>
                !esNombreIdentificadorInvalido(c.cn) &&
                (c.esFeaAcreditada || c.esHardwareProvider || Boolean(c.rut)),
            );
          mapped.sort((a, b) => (b.esFeaAcreditada ? 1 : 0) - (a.esFeaAcreditada ? 1 : 0));
          resolve(mapped);
        } catch {
          resolve([]);
        }
      },
    );
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
      lastKnownState !== null &&
      (currentState !== lastKnownState ||
        (currentState === 'CONECTADO' && currentSerial !== lastKnownSerial));

    const isFirstScan = lastKnownState === null;
    const now = Date.now();
    const heartbeatDue = !isFirstScan && now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS;

    let certNewlyResolved = false;
    if (currentState === 'CONECTADO' && detectedToken) {
      if (
        !stateChanged &&
        lastKnownToken?.certMeta?.titularNombre &&
        lastKnownSerial === currentSerial
      ) {
        detectedToken.certMeta = lastKnownToken.certMeta;
      } else {
        try {
          const certs = await listarCertificadosTokenWindows();
          if (certs && certs.length > 0) {
            const c = certs[0];
            const subj = String(c.subject || '');
            const emailM = subj.match(/E=([^,]+)/i);
            const cargoM = subj.match(/\bT=([^,]+)/i);
            const ouM = subj.match(/OU=RA\s*-\s*([^,]+)/i) || subj.match(/OU=([^,]+)/i);
            detectedToken.certMeta = {
              titularNombre: c.cn || null,
              titularRut: c.rut || null,
              titularEmail: emailM ? emailM[1].trim() : null,
              titularCargo: cargoM ? cargoM[1].trim() : null,
              titularUnidad: ouM ? ouM[1].trim() : null,
              certSerialNumber: c.serialNumber || null,
              certNotAfter: c.notAfter || null,
              certIssuer: c.issuer || null,
              certThumbprint: c.thumbprint || null,
            };
            guardarCacheCertToken(detectedToken.serialNumber, detectedToken.certMeta);
            if (!lastKnownToken?.certMeta?.titularNombre && detectedToken.certMeta.titularNombre) {
              certNewlyResolved = true;
            }
          } else {
            const cachedMeta = obtenerCacheCertToken(detectedToken.serialNumber);
            if (cachedMeta?.titularNombre) detectedToken.certMeta = cachedMeta;
          }
        } catch {
          const cachedMeta = obtenerCacheCertToken(detectedToken.serialNumber);
          if (cachedMeta?.titularNombre) detectedToken.certMeta = cachedMeta;
        }
      }
    }

    const shouldSend =
      stateChanged ||
      certNewlyResolved ||
      isFirstScan ||
      heartbeatDue;

    if (!shouldSend) return;

    if (stateChanged || certNewlyResolved || (isFirstScan && currentState === 'CONECTADO')) {
      if (currentState === 'CONECTADO' && detectedToken) {
        console.log(
          `[GhostAgent] [USB CONECTADO] ${detectedToken.marca} - ${detectedToken.modelo} (S/N: ${detectedToken.serialNumber})${
            detectedToken.certMeta?.titularNombre ? ` | Titular: ${detectedToken.certMeta.titularNombre}` : ''
          }`,
        );
      } else if (currentState === 'DESCONECTADO' && lastKnownToken) {
        console.log(
          `[GhostAgent] [USB DESCONECTADO] Token removido de ${HOSTNAME} (S/N: ${lastKnownToken.serialNumber}).`,
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
        stateChanged: stateChanged || (isFirstScan && currentState === 'CONECTADO'),
        isHeartbeat: !stateChanged && !isFirstScan,
        previousSerialNumber: !detectedToken && lastKnownToken ? lastKnownToken.serialNumber : undefined,
        ...(detectedToken?.certMeta || {}),
      },
    };

    lastKnownState = currentState;
    lastKnownSerial = currentSerial;
    if (detectedToken) lastKnownToken = detectedToken;
    lastHeartbeatAt = now;

    await sendTelemetryWithBackoff(payload);
  } finally {
    isScanning = false;
  }
}

async function handleGracefulShutdown() {
  console.log(`\n[GhostAgent] Cerrando agente en ${HOSTNAME}. Notificando DESCONECTADO...`);
  try {
    await fetch(API_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
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
  } catch {}
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
  if (electronApp.dock) electronApp.dock.hide();

  try {
    electronApp.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    electronApp.setAsDefaultProtocolClient('coquimbo-agent');
  } catch {}

  if (ipcMain) {
    ipcMain.handle('get-workstation-hostname', () => HOSTNAME);
    ipcMain.on('webhid-usb-event', (_event, hidPayload) => {
      console.log(
        `[GhostAgent] [WebHID] ${hidPayload?.codigoPc || HOSTNAME}: ${hidPayload?.tipo} (vendorId=${hidPayload?.vendorId})`,
      );
      monitorUsbLoop();
    });
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

    hiddenWin.webContents.session.setDevicePermissionHandler(() => true);
    hiddenWin.webContents.session.on('select-hid-device', (event, details, callback) => {
      event.preventDefault();
      if (details.deviceList && details.deviceList.length > 0) {
        callback(details.deviceList[0].deviceId);
      } else {
        callback();
      }
    });

    const rendererHtml = `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>GhostAgent WebHID Renderer</title></head>
        <body>
          <script>
            const { ipcRenderer } = require('electron');
            const ALLOWED_VENDORS = [0x0529, 0x0DC3, 0x096E, 0x08E6, 0x04B9, 0x076B, 0x04E6, 0x0A89, 0x1050, 0x20A0];
            (async () => {
              const codigoPc = await ipcRenderer.invoke('get-workstation-hostname');
              if (navigator.hid) {
                navigator.hid.addEventListener('connect', ({ device }) => {
                  if (!device || ALLOWED_VENDORS.includes(device.vendorId)) {
                    ipcRenderer.send('webhid-usb-event', {
                      codigoPc,
                      tipo: 'connect',
                      vendorId: device ? '0x' + device.vendorId.toString(16).toUpperCase().padStart(4, '0') : 'UNKNOWN',
                      productName: device ? device.productName : 'Token USB',
                      timestamp: new Date().toISOString()
                    });
                  }
                });
                navigator.hid.addEventListener('disconnect', ({ device }) => {
                  if (!device || ALLOWED_VENDORS.includes(device.vendorId)) {
                    ipcRenderer.send('webhid-usb-event', {
                      codigoPc,
                      tipo: 'disconnect',
                      vendorId: device ? '0x' + device.vendorId.toString(16).toUpperCase().padStart(4, '0') : 'UNKNOWN',
                      productName: device ? device.productName : 'Token USB',
                      timestamp: new Date().toISOString()
                    });
                  }
                });
              }
            })();
          </script>
        </body>
      </html>
    `;
    hiddenWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml)}`);

    startHeadlessAgent();
  });

  electronApp.on('window-all-closed', (e) => {
    e.preventDefault();
  });
} else {
  startHeadlessAgent();
}

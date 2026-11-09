/**
 * SIMULADOR DE TELEMETRÍA MULTI-ESTACIÓN (TESTING / DESARROLLO)
 * Ilustre Municipalidad de Coquimbo
 *
 * Permite simular ráfagas de eventos de inserción, firma PKCS#11 y desconexión
 * de tokens USB en las estaciones municipales hacia POST /api/v1/telemetria/usb.
 *
 * Uso: node simulator.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let fileConfig = {};
try {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch {}

const API_URL =
  process.env.TELEMETRIA_API_URL ||
  fileConfig.apiUrl ||
  'http://localhost:3001/api/v1/telemetria/usb';
const API_KEY =
  process.env.TELEMETRIA_API_KEY ||
  fileConfig.apiKey ||
  'muni-coquimbo-ghost-app-sec-key-2026';

const ESTACIONES_SIMULADAS = [
  {
    codigoPc: 'PC-SECMUN-01',
    ipAsignada: '10.10.10.22',
    dependenciaFisica: 'Edificio Consistorial - Piso 2 (Secretaría Municipal)',
    serialNumber: 'SN-SAFENET-CQM-0002',
    vendorId: '0x0529',
    marca: 'Thales / SafeNet',
    modelo: 'eToken 5110 CC (FIPS 140-2 Nivel 3)',
    estadoHardware: 'CONECTADO',
  },
  {
    codigoPc: 'PC-DOM-05',
    ipAsignada: '10.10.12.104',
    dependenciaFisica: 'Dirección de Obras Municipales - Box 05',
    serialNumber: 'SN-SAFENET-CQM-0003',
    vendorId: '0x0529',
    marca: 'Thales / SafeNet',
    modelo: 'eToken 5110 CC (FIPS 140-2 Nivel 3)',
    estadoHardware: 'CONECTADO',
  },
  {
    codigoPc: os.hostname().toUpperCase(),
    ipAsignada: '10.10.15.200',
    dependenciaFisica: 'Estación de Desarrollo Local (Host Activo)',
    serialNumber: 'SN-SAFENET-DEV-9901',
    vendorId: '0x0529',
    marca: 'Thales / SafeNet',
    modelo: 'eToken 5110 CC (FIPS 140-2 Nivel 3)',
    estadoHardware: 'CONECTADO',
  },
];

async function runSimulation() {
  console.log(`=== Simulador Ghost App Coquimbo -> ${API_URL} ===`);
  for (const est of ESTACIONES_SIMULADAS) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': API_KEY,
        },
        body: JSON.stringify({
          ...est,
          timestamp: new Date().toISOString(),
          metadatos: {
            agentVersion: '2.0.0-simulator',
            hostname: est.codigoPc,
            pkcs11Slot: 0,
            fipsLevel: 'FIPS 140-2 Level 3',
          },
        }),
      });
      const data = await res.json();
      console.log(`[OK] ${est.codigoPc} (${est.estadoHardware}):`, data.status);
    } catch (err) {
      console.error(`[ERROR] ${est.codigoPc}:`, err.message);
    }
  }
}

runSimulation();

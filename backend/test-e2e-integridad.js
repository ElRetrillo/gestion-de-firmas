'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';
const CONTAINER_BACKEND = 'gestion-firmas-backend';
const CONTAINER_POSTGRES = 'gestion-firmas-postgres';
const CONTAINER_REDIS = 'gestion-firmas-redis';

const TEST_SERIAL = 'SN-08E6-E2ETEST001';
const TEST_PC = 'PC-E2E-TEST-01';
const TEST_IP = '10.99.99.50';
const TEST_NOMBRE = 'José Andrés Núñez Peña';
const TEST_EMAIL = 'jose.nunez.e2e@municoquimbo.cl';
const TEST_CARGO = 'Profesional E2E';
const TEST_UNIDAD = 'Unidad E2E';
const TEST_CERT_EXP = '2026-12-10T12:00:00Z';

const VALID_USERS = [
  'Daniel Alejandro Trigo Tabilo',
  'Ignacio Alejandro Rosales Riffo',
  'Camila Constanza Herrera Pastén',
  'Tomas Edgardo Ovando Cortes',
];

const results = [];

function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER_POSTGRES, 'psql', '-U', 'postgres', '-d', 'gestion_firmas', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

function psqlLines(sql) {
  const out = psqlScalar(sql);
  return out ? out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

function redisCmd(...args) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER_REDIS, 'redis-cli', ...args],
    { encoding: 'utf8' },
  ).trim();
}

async function httpJson(urlPath, options = {}) {
  const res = await fetch(`${BASE_URL}${urlPath}`, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, body: json, raw: text };
}

function getJwtSecret() {
  try {
    const out = execFileSync(
      'docker',
      ['exec', CONTAINER_BACKEND, 'printenv', 'JWT_SECRET'],
      { encoding: 'utf8' },
    ).trim();
    if (out) return out;
  } catch {
    // fallback a .env raíz si fuera necesario
  }
  const rootEnvPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(rootEnvPath)) {
    const content = fs.readFileSync(rootEnvPath, 'utf8');
    const match = content.match(/^JWT_SECRET=(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('No se pudo obtener JWT_SECRET del contenedor ni de .env');
}

function signTestAdminJwt(adminUser) {
  const secret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: adminUser.id,
      rut: adminUser.rut,
      rol: 'ADMIN',
      email: adminUser.email,
      unidad: adminUser.unidad || 'Dirección de TICs',
      dcp: false,
      iat: now,
      exp: now + 300,
      iss: 'municoquimbo-tics-anci',
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function limpiarDatosE2E() {
  const sqlStatements = [
    `DELETE FROM telemetria_eventos WHERE codigo_pc = '${TEST_PC}' OR token_id IN (SELECT id FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}') OR metadatos_jsonb::text LIKE '%${TEST_SERIAL}%';`,
    `DELETE FROM estaciones_trabajo WHERE codigo_pc = '${TEST_PC}' OR serial_token_activo = '${TEST_SERIAL}';`,
    `DELETE FROM certificados WHERE numero_serie = 'CERT-${TEST_SERIAL}' OR token_hardware_id IN (SELECT id FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}') OR usuario_id IN (SELECT id FROM usuarios WHERE email = '${TEST_EMAIL}');`,
    `DELETE FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}';`,
    `DELETE FROM historial_cambios WHERE usuario_email = '${TEST_EMAIL}' OR registro_id = '${TEST_SERIAL}';`,
    `DELETE FROM usuarios WHERE email = '${TEST_EMAIL}';`,
  ];

  for (const sql of sqlStatements) {
    psqlScalar(sql);
  }

  redisCmd(
    'DEL',
    `pc:status:${TEST_PC}`,
    `token:cert_meta:${TEST_SERIAL}`,
    `token:connected_at:${TEST_PC}`,
  );
}

async function runTest(id, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const durationMs = Date.now() - started;
    results.push({ id, name, status: 'PASS', durationMs, detail: detail || 'OK' });
    console.log(`[PASS] ${id} - ${name} (${durationMs}ms)${detail ? ` -> ${detail}` : ''}`);
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err && err.message ? err.message : String(err);
    results.push({ id, name, status: 'FAIL', durationMs, detail: message });
    console.error(`[FAIL] ${id} - ${name} (${durationMs}ms) -> ${message}`);
  }
}

async function main() {
  console.log('=== INICIO SUITE E2E INTEGRIDAD SISTEMA GESTION DE FIRMAS ===');

  const baselineCounts = {
    usuarios: Number(psqlScalar('SELECT COUNT(*) FROM usuarios;')),
    tokens: Number(psqlScalar('SELECT COUNT(*) FROM tokens_hardware;')),
    certificados: Number(psqlScalar('SELECT COUNT(*) FROM certificados;')),
    estaciones: Number(psqlScalar('SELECT COUNT(*) FROM estaciones_trabajo;')),
    eventos: Number(psqlScalar('SELECT COUNT(*) FROM telemetria_eventos;')),
    historial: Number(psqlScalar('SELECT COUNT(*) FROM historial_cambios;')),
  };
  console.log('Conteo inicial PostgreSQL:', JSON.stringify(baselineCounts));

  // -------------------------------------------------------------------------
  // 1. Integridad de Limpieza Permanente
  // -------------------------------------------------------------------------
  await runTest(
    '1.1',
    'Contenedor backend sin seed de prueba SN-0529-CQM en /app/dist/',
    async () => {
      const proc = spawnSync(
        'docker',
        ['exec', CONTAINER_BACKEND, 'grep', '-rn', 'SN-0529-CQM', '/app/dist/'],
        { encoding: 'utf8' },
      );
      if (proc.error) throw proc.error;
      assert.equal(
        proc.status,
        1,
        `Se esperaba exit code 1 (sin coincidencias), recibido ${proc.status}. Output: ${proc.stdout} ${proc.stderr}`,
      );
      assert.equal((proc.stdout || '').trim(), '', 'No debe haber coincidencias de SN-0529-CQM');
      return '0 coincidencias en /app/dist/ (exit code 1)';
    },
  );

  await runTest(
    '1.2',
    'PostgreSQL limpio (sin demos, bitácora limpia, 2 superadmins y 3 tokens reales)',
    async () => {
      const demoTokensCount = Number(
        psqlScalar(
          "SELECT COUNT(*) FROM tokens_hardware WHERE serial_number LIKE 'SN-0529-CQM-%' OR serial_number LIKE 'SN-08E6-CQM-%' OR serial_number LIKE 'SN-096E-CQM-%' OR serial_number LIKE 'SN-0DC3-CQM-%';",
        ),
      );
      assert.equal(demoTokensCount, 0, `Tokens demo residuales encontrados: ${demoTokensCount}`);

      const demoStationsCount = Number(
        psqlScalar("SELECT COUNT(*) FROM estaciones_trabajo WHERE codigo_pc LIKE 'PC-SECMUN-%';"),
      );
      assert.equal(demoStationsCount, 0, `Estaciones PC-SECMUN-% residuales encontradas: ${demoStationsCount}`);

      const usuarios = psqlLines('SELECT nombre FROM usuarios ORDER BY nombre;');
      assert.equal(usuarios.length, 4, `Se esperaban 4 usuarios, encontrados ${usuarios.length}: ${usuarios.join(', ')}`);
      for (const expectedUser of VALID_USERS) {
        assert.ok(usuarios.includes(expectedUser), `Falta usuario válido UTF-8: ${expectedUser}`);
      }

      const admins = psqlLines("SELECT rut || ':' || estado FROM usuarios WHERE rol = 'ADMIN' ORDER BY rut;");
      assert.deepEqual(
        admins,
        ['20.406.484-9:ACTIVO', '21.374.808-4:ACTIVO'],
        `Superadmins esperados [20.406.484-9:ACTIVO, 21.374.808-4:ACTIVO], encontrados: ${admins.join(', ')}`,
      );

      assert.equal(baselineCounts.historial, 0, `Se esperaba historial_cambios limpio (0), hay ${baselineCounts.historial}`);
      const adminRow = psqlScalar(
        "SELECT id || '|' || rut || '|' || email || '|' || unidad FROM usuarios WHERE rol = 'ADMIN' AND estado = 'ACTIVO' LIMIT 1;",
      );
      assert.ok(adminRow, 'No se encontró ADMIN activo');
      const [id, rut, email, unidad] = adminRow.split('|');
      const jwt = signTestAdminJwt({ id, rut, email, unidad });
      const audRes = await httpJson('/api/v1/auditoria', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert.equal(audRes.status, 200, `GET /api/v1/auditoria devolvió ${audRes.status}`);
      assert.ok(Array.isArray(audRes.body) && audRes.body.length === 0, 'Bitácora API aún tiene registros');

      const tokens = psqlLines('SELECT serial_number FROM tokens_hardware ORDER BY serial_number;');
      assert.equal(tokens.length, 3, `Se esperaban 3 tokens reales, encontrados ${tokens.length}: ${tokens.join(', ')}`);

      return `superadmins=${admins.join(' & ')}, historial=0, tokens=3 (${tokens.join(', ')})`;
    },
  );

  // -------------------------------------------------------------------------
  // 2. Flujo Completo Ghost App (Inserción -> UTF-8 -> Desconexión -> Limpieza)
  // -------------------------------------------------------------------------
  try {
    await runTest(
      '2.1',
      'Ghost App POST /telemetria/usb inserta token E2E con titular UTF-8 y activa usuario/token',
      async () => {
        const payload = {
          codigoPc: TEST_PC,
          estadoHardware: 'CONECTADO',
          serialNumber: TEST_SERIAL,
          vendorId: '0x08E6',
          marca: 'Thales / Gemalto',
          modelo: 'Ezio Generic',
          ipAsignada: TEST_IP,
          dependenciaFisica: TEST_UNIDAD,
          timestamp: new Date().toISOString(),
          metadatos: {
            stateChanged: true,
            isHeartbeat: false,
            titularNombre: TEST_NOMBRE,
            titularEmail: TEST_EMAIL,
            titularCargo: TEST_CARGO,
            titularUnidad: TEST_UNIDAD,
            certNotAfter: TEST_CERT_EXP,
          },
        };

        const res = await httpJson('/api/v1/telemetria/usb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        });

        assert.equal(res.status, 200, `Status esperado 200, recibido ${res.status}: ${res.raw}`);
        assert.equal(res.body?.status, 'success');
        assert.equal(res.body?.codigoPc, TEST_PC);
        assert.equal(res.body?.estadoHardware, 'CONECTADO');
        assert.equal(res.body?.serialTokenActivo, TEST_SERIAL);

        // Verificar PostgreSQL usuarios
        const userRow = psqlScalar(
          `SELECT nombre || '|' || estado || '|' || cargo || '|' || unidad FROM usuarios WHERE email = '${TEST_EMAIL}';`,
        );
        assert.ok(userRow, 'Usuario E2E no fue creado en tabla usuarios');
        const [dbNombre, dbEstado, dbCargo, dbUnidad] = userRow.split('|');
        assert.equal(dbNombre, TEST_NOMBRE, `UTF-8 incorrecto en usuarios.nombre: "${dbNombre}"`);
        assert.equal(dbEstado, 'ACTIVO', `Estado esperado ACTIVO, obtenido ${dbEstado}`);
        assert.equal(dbCargo, TEST_CARGO);
        assert.equal(dbUnidad, TEST_UNIDAD);

        // Verificar PostgreSQL tokens_hardware
        const tokenState = psqlScalar(
          `SELECT estado_patrimonial FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}';`,
        );
        assert.equal(tokenState, 'ASIGNADO', `Estado patrimonial esperado ASIGNADO, obtenido ${tokenState}`);

        return `usuario="${dbNombre}" (${dbEstado}), token=${TEST_SERIAL} (${tokenState})`;
      },
    );

    await runTest(
      '2.2',
      'Token E2E aparece CONECTADO en GET /telemetria/estaciones y GET /telemetria/metricas',
      async () => {
        const estRes = await httpJson('/api/v1/telemetria/estaciones');
        assert.equal(estRes.status, 200, `GET /estaciones devolvió ${estRes.status}`);
        assert.ok(Array.isArray(estRes.body), '/estaciones debe devolver un array');

        const est = estRes.body.find((e) => e.codigoPc === TEST_PC);
        assert.ok(est, `Estación ${TEST_PC} no encontrada en /telemetria/estaciones`);
        assert.equal(est.estadoEnVivo, 'CONECTADO');
        assert.equal(est.ipAsignada, TEST_IP);
        assert.equal(est.serialTokenActivo, TEST_SERIAL);
        assert.equal(est.tokenInfo?.titularNombre, TEST_NOMBRE);

        const metRes = await httpJson('/api/v1/telemetria/metricas?modo=ULTIMOS_30_DIAS');
        assert.equal(metRes.status, 200, `GET /metricas devolvió ${metRes.status}`);

        const disp = metRes.body?.telemetria?.trazabilidadDispositivos?.find(
          (d) => d.serialNumber === TEST_SERIAL,
        );
        assert.ok(disp, `Token ${TEST_SERIAL} no encontrado en telemetria.trazabilidadDispositivos`);
        assert.equal(disp.estadoEnVivo, 'CONECTADO');
        assert.equal(disp.ultimaIp, TEST_IP);
        assert.equal(disp.funcionarioAsignado?.nombre, TEST_NOMBRE);

        const firma = metRes.body?.firmasAsignadas?.listado?.find(
          (f) => f.serialNumberToken === TEST_SERIAL,
        );
        assert.ok(firma, `Token ${TEST_SERIAL} no encontrado en firmasAsignadas.listado`);
        assert.equal(firma.estadoConexion, 'CONECTADO');
        assert.equal(firma.funcionario?.nombre, TEST_NOMBRE);

        return `estaciones=CONECTADO, metricas=CONECTADO, IP=${disp.ultimaIp}, titular="${disp.funcionarioAsignado?.nombre}"`;
      },
    );

    await runTest(
      '2.3',
      'Ghost App POST /telemetria/usb DESCONECTADO pasa estado a DESCONECTADO y conserva ultimaIp',
      async () => {
        const disconnectPayload = {
          codigoPc: TEST_PC,
          estadoHardware: 'DESCONECTADO',
          timestamp: new Date().toISOString(),
          metadatos: {
            previousSerialNumber: TEST_SERIAL,
            stateChanged: true,
            isHeartbeat: false,
          },
        };

        const discRes = await httpJson('/api/v1/telemetria/usb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(disconnectPayload),
        });
        assert.equal(discRes.status, 200, `POST desconexión devolvió ${discRes.status}: ${discRes.raw}`);
        assert.equal(discRes.body?.estadoHardware, 'DESCONECTADO');
        assert.equal(discRes.body?.serialTokenActivo, null);

        const metRes = await httpJson('/api/v1/telemetria/metricas?modo=ULTIMOS_30_DIAS');
        assert.equal(metRes.status, 200);

        const disp = metRes.body?.telemetria?.trazabilidadDispositivos?.find(
          (d) => d.serialNumber === TEST_SERIAL,
        );
        assert.ok(disp, `Token ${TEST_SERIAL} desapareció tras desconexión`);
        assert.equal(disp.estadoEnVivo, 'DESCONECTADO', `Esperado DESCONECTADO, recibido ${disp.estadoEnVivo}`);
        assert.equal(disp.ultimaIp, TEST_IP, `ultimaIp esperada ${TEST_IP}, recibida ${disp.ultimaIp}`);

        const firma = metRes.body?.firmasAsignadas?.listado?.find(
          (f) => f.serialNumberToken === TEST_SERIAL,
        );
        assert.ok(firma);
        assert.equal(firma.estadoConexion, 'DESCONECTADO');

        return `estadoEnVivo=${disp.estadoEnVivo}, ultimaIp=${disp.ultimaIp}`;
      },
    );
  } finally {
    await runTest(
      '2.4',
      'Limpieza post-test en PostgreSQL y Redis (finally)',
      async () => {
        limpiarDatosE2E();

        const remUsers = Number(psqlScalar(`SELECT COUNT(*) FROM usuarios WHERE email = '${TEST_EMAIL}';`));
        const remTokens = Number(psqlScalar(`SELECT COUNT(*) FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}';`));
        const remStations = Number(psqlScalar(`SELECT COUNT(*) FROM estaciones_trabajo WHERE codigo_pc = '${TEST_PC}';`));
        const remCerts = Number(psqlScalar(`SELECT COUNT(*) FROM certificados WHERE numero_serie = 'CERT-${TEST_SERIAL}';`));
        const remEvents = Number(psqlScalar(`SELECT COUNT(*) FROM telemetria_eventos WHERE codigo_pc = '${TEST_PC}';`));

        assert.equal(remUsers, 0, `Usuarios E2E residuales: ${remUsers}`);
        assert.equal(remTokens, 0, `Tokens E2E residuales: ${remTokens}`);
        assert.equal(remStations, 0, `Estaciones E2E residuales: ${remStations}`);
        assert.equal(remCerts, 0, `Certificados E2E residuales: ${remCerts}`);
        assert.equal(remEvents, 0, `Eventos E2E residuales: ${remEvents}`);

        const redisKeysRaw = redisCmd('KEYS', '*');
        assert.ok(!redisKeysRaw.includes(TEST_PC), `Redis aún contiene ${TEST_PC}`);
        assert.ok(!redisKeysRaw.includes(TEST_SERIAL), `Redis aún contiene ${TEST_SERIAL}`);

        return '0 registros residuales en PostgreSQL y Redis';
      },
    );
  }

  // -------------------------------------------------------------------------
  // 3. Métricas y Filtros (7d, 15d, 30d, 60d, POR_MES, POR_ANIO)
  // -------------------------------------------------------------------------
  const modos = [
    'ULTIMOS_7_DIAS',
    'ULTIMOS_15_DIAS',
    'ULTIMOS_30_DIAS',
    'ULTIMOS_60_DIAS',
    'POR_MES',
    'POR_ANIO',
  ];

  await runTest(
    '3.1',
    'GET /api/v1/telemetria/metricas con filtros 7d, 15d, 30d, 60d, POR_MES y POR_ANIO',
    async () => {
      const summary = [];
      for (const modo of modos) {
        const res = await httpJson(`/api/v1/telemetria/metricas?modo=${encodeURIComponent(modo)}`);
        assert.equal(res.status, 200, `Modo ${modo} devolvió status ${res.status}`);
        const d = res.body;
        assert.ok(d && typeof d === 'object', `Modo ${modo} no devolvió objeto JSON`);
        assert.equal(d.periodo?.modo, modo, `periodo.modo esperado ${modo}, obtenido ${d.periodo?.modo}`);
        assert.ok(d.resumenDispositivos && typeof d.resumenDispositivos === 'object', `${modo}: falta resumenDispositivos`);
        assert.ok(Array.isArray(d.firmasAsignadas?.listado), `${modo}: falta firmasAsignadas.listado`);
        assert.equal(typeof d.telemetria?.promedioUsoDiarioGeneralMinutos, 'number', `${modo}: falta promedioUsoDiarioGeneralMinutos`);
        assert.equal(typeof d.telemetria?.tiempoUsoTotalMinutos, 'number', `${modo}: falta tiempoUsoTotalMinutos`);
        for (const item of d.firmasAsignadas.listado) {
          assert.equal(typeof item.promedioUsoDiarioMinutos, 'number', `${modo}: falta promedioUsoDiarioMinutos en ${item.serialNumberToken}`);
        }
        assert.ok(d.alertasVencimiento && typeof d.alertasVencimiento === 'object', `${modo}: falta alertasVencimiento`);
        assert.ok(Array.isArray(d.alertasVencimiento.tokensEnAlerta), `${modo}: falta alertasVencimiento.tokensEnAlerta`);
        assert.ok(d.contratosResumen && typeof d.contratosResumen === 'object', `${modo}: falta contratosResumen`);
        assert.ok(Array.isArray(d.contratosResumen.listado), `${modo}: falta contratosResumen.listado`);
        assert.ok(Array.isArray(d.serieTemporal) && d.serieTemporal.length > 0, `${modo}: serieTemporal vacía`);
        summary.push(`${modo}(dias=${d.serieTemporal.length})`);
      }
      return summary.join(', ');
    },
  );

  // -------------------------------------------------------------------------
  // 4. Plantilla de Correo de Caducidad y SMTP
  // -------------------------------------------------------------------------
  await runTest(
    '4.1',
    'Plantilla compilada dist/usuarios/correo-aviso.template.js incluye datos y omite RUT',
    async () => {
      const tplPath = path.join(__dirname, 'dist', 'usuarios', 'correo-aviso.template.js');
      assert.ok(fs.existsSync(tplPath), `No existe plantilla compilada en ${tplPath}`);
      const { generarPlantillaCorreoCaducidad } = require(tplPath);
      assert.equal(typeof generarPlantillaCorreoCaducidad, 'function');

      const dummyRut = '19.876.543-2';
      const out = generarPlantillaCorreoCaducidad({
        nombre: 'Camila Constanza Herrera Pastén',
        rut: dummyRut,
        fechaVencimiento: '2026-11-28',
        diasRestantes: 10,
        serialNumber: 'SN-08E6-6A85ED934499',
      });

      assert.ok(out.html.includes('Camila Constanza Herrera Pastén'), 'HTML no incluye nombre titular');
      assert.ok(out.text.includes('Camila Constanza Herrera Pastén'), 'TEXT no incluye nombre titular');
      assert.ok(out.html.includes('2026-11-28'), 'HTML no incluye fecha de vencimiento');
      assert.ok(out.text.includes('2026-11-28'), 'TEXT no incluye fecha de vencimiento');
      assert.ok(out.html.includes('10 días'), 'HTML no incluye días restantes');
      assert.ok(out.text.includes('10 días'), 'TEXT no incluye días restantes');
      assert.ok(out.subject.includes('10 días'), 'Subject no incluye días restantes');

      assert.ok(!out.html.includes(dummyRut), 'HTML filtró el valor del RUT');
      assert.ok(!out.text.includes(dummyRut), 'TEXT filtró el valor del RUT');
      assert.ok(!out.subject.includes(dummyRut), 'Subject filtró el valor del RUT');

      assert.match(
        out.html,
        /<b>RUT:<\/b><\/td>\s*<td[^>]*>&nbsp;<\/td>/,
        'La fila RUT: en HTML no tiene valor en blanco / &nbsp;',
      );
      assert.match(out.text, /^RUT:\s*$/m, 'La línea RUT: en texto plano no está en blanco');

      return 'Titular, fecha y días OK; fila RUT: en blanco (&nbsp;) sin exposición';
    },
  );

  await runTest(
    '4.2',
    'Endpoints SMTP Preview (POST /usuarios/alertas-vencimiento/despachar) y TOTP Issuer (GET /auth/totp/setup)',
    async () => {
      const adminRow = psqlScalar(
        "SELECT id || '|' || rut || '|' || email || '|' || unidad FROM usuarios WHERE rol = 'ADMIN' AND estado = 'ACTIVO' LIMIT 1;",
      );
      assert.ok(adminRow, 'No se encontró usuario ADMIN activo para firmar JWT temporal');
      const [id, rut, email, unidad] = adminRow.split('|');
      const jwt = signTestAdminJwt({ id, rut, email, unidad });

      const dummyRut = '19.876.543-2';
      const res = await httpJson('/api/v1/usuarios/alertas-vencimiento/despachar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          nombre: 'Camila Constanza Herrera Pastén',
          rut: dummyRut,
          email: 'camila.herrera@municoquimbo.cl',
          fechaExpiracion: '2026-11-28',
          diasRestantes: 10,
          serialNumber: 'SN-08E6-6A85ED934499',
          soloPreview: true,
        }),
      });

      assert.ok(res.status === 200 || res.status === 201, `Status inesperado ${res.status}: ${res.raw}`);
      assert.equal(res.body?.status, 'preview');
      assert.equal(res.body?.enviadoSmtp, false);
      assert.equal(res.body?.remitenteSmtp, 'datrigob@gmail.com');
      assert.ok(res.body?.htmlCorreo?.includes('Camila Constanza Herrera Pastén'));
      assert.ok(res.body?.htmlCorreo?.includes('2026-11-28'));
      assert.ok(res.body?.htmlCorreo?.includes('10 días'));
      assert.ok(!res.body?.htmlCorreo?.includes(dummyRut), 'Endpoint preview filtró RUT en HTML');
      assert.ok(!res.body?.cuerpoCorreo?.includes(dummyRut), 'Endpoint preview filtró RUT en texto');
      assert.match(res.body.htmlCorreo, /<b>RUT:<\/b><\/td>\s*<td[^>]*>&nbsp;<\/td>/);

      const expectedIssuer = 'Gestion de tokens - I.Municipalidad de Coquimbo';
      const totpRes = await httpJson('/api/v1/auth/totp/setup', {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert.equal(totpRes.status, 200, `GET /auth/totp/setup devolvió ${totpRes.status}: ${totpRes.raw}`);
      assert.equal(totpRes.body?.emisor, expectedIssuer, `Emisor TOTP esperado "${expectedIssuer}", obtenido "${totpRes.body?.emisor}"`);
      assert.ok(
        decodeURIComponent(totpRes.body?.otpauthUrl || '').includes(expectedIssuer),
        `otpauthUrl no contiene el emisor "${expectedIssuer}"`,
      );

      return `status=${res.status}, remitente=${res.body.remitenteSmtp}, emisorTOTP="${totpRes.body.emisor}"`;
    },
  );

  await runTest(
    '4.3',
    'Verificación SMTP real (nodemailer.verify) dentro de gestion-firmas-backend',
    async () => {
      const containerScript = `
        const fs = require('fs');
        const nodemailer = require('nodemailer');
        const lines = fs.readFileSync('/app/.env', 'utf8').replace(/^\\uFEFF/, '').split(/\\r?\\n/);
        for (const l of lines) {
          const idx = l.indexOf('=');
          if (idx > 0) {
            const k = l.slice(0, idx).trim();
            const v = l.slice(idx + 1).trim().replace(/^"|"$/g, '');
            if (!process.env[k]) process.env[k] = v;
          }
        }
        if (process.env.SMTP_HOST !== 'smtp.gmail.com' || Number(process.env.SMTP_PORT) !== 587 || process.env.SMTP_USER !== 'datrigob@gmail.com') {
          throw new Error('Configuración SMTP inesperada: ' + process.env.SMTP_HOST + ':' + process.env.SMTP_PORT + ' ' + process.env.SMTP_USER);
        }
        const t = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        t.verify().then(() => {
          console.log('SMTP_VERIFY_OK');
        }).catch((err) => {
          console.error('SMTP_VERIFY_ERROR:', err.message);
          process.exit(1);
        });
      `;

      const out = execFileSync(
        'docker',
        ['exec', '-i', CONTAINER_BACKEND, 'node', '-'],
        { input: containerScript, encoding: 'utf8' },
      ).trim();

      assert.ok(out.includes('SMTP_VERIFY_OK'), `Salida inesperada de nodemailer.verify(): ${out}`);
      return 'smtp.gmail.com:587 (datrigob@gmail.com) -> SMTP_VERIFY_OK';
    },
  );

  // -------------------------------------------------------------------------
  // 5. Verificación Final de Integridad Post-Limpieza
  // -------------------------------------------------------------------------
  let finalCounts = {};
  await runTest(
    '5.1',
    'Conteo final PostgreSQL intacto y API limpia sin rastros E2E',
    async () => {
      finalCounts = {
        usuarios: Number(psqlScalar('SELECT COUNT(*) FROM usuarios;')),
        tokens: Number(psqlScalar('SELECT COUNT(*) FROM tokens_hardware;')),
        certificados: Number(psqlScalar('SELECT COUNT(*) FROM certificados;')),
        estaciones: Number(psqlScalar('SELECT COUNT(*) FROM estaciones_trabajo;')),
        eventos: Number(psqlScalar('SELECT COUNT(*) FROM telemetria_eventos;')),
        historial: Number(psqlScalar('SELECT COUNT(*) FROM historial_cambios;')),
      };

      assert.equal(finalCounts.usuarios, 4, `Esperados 4 usuarios, hay ${finalCounts.usuarios}`);
      assert.equal(finalCounts.tokens, 3, `Esperados 3 tokens, hay ${finalCounts.tokens}`);
      assert.equal(finalCounts.certificados, baselineCounts.certificados);
      assert.equal(finalCounts.estaciones, baselineCounts.estaciones);
      assert.equal(finalCounts.eventos, baselineCounts.eventos);
      assert.equal(finalCounts.historial, baselineCounts.historial);

      const estRes = await httpJson('/api/v1/telemetria/estaciones');
      assert.equal(estRes.status, 200);
      assert.ok(!estRes.body.some((e) => e.codigoPc === TEST_PC), 'API /estaciones aún expone PC E2E');

      const metRes = await httpJson('/api/v1/telemetria/metricas?modo=ULTIMOS_30_DIAS');
      assert.equal(metRes.status, 200);
      assert.equal(metRes.body?.resumenDispositivos?.totalExistentes, 3);

      return JSON.stringify(finalCounts);
    },
  );

  console.log('\n=== RESUMEN FINAL E2E ===');
  for (const r of results) {
    console.log(`${r.status.padEnd(4)} | ${r.id} | ${r.name} | ${r.detail}`);
  }
  console.log('Conteo final PostgreSQL:', JSON.stringify(finalCounts));

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.error(`\nFallaron ${failed.length} de ${results.length} pruebas.`);
    process.exit(1);
  }
  console.log(`\nTodas las pruebas (${results.length}/${results.length}) pasaron exitosamente.`);
}

main().catch((err) => {
  console.error('Error fatal en test E2E:', err);
  try {
    limpiarDatosE2E();
  } catch (cleanupErr) {
    console.error('Error durante limpieza de emergencia:', cleanupErr);
  }
  process.exit(1);
});

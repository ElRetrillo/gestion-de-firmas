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

const TEST_ADMIN_RUT = '19.999.888-7';
const TEST_ADMIN_NOMBRE = 'Administrador Temporal E2E';
const TEST_ADMIN_EMAIL = 'admin.temp.e2e@municoquimbo.cl';
const TEST_ADMIN_PIN_INIT = '654321';
const TEST_ADMIN_PIN_NEW = '765432';

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
  return { status: res.status, ok: res.ok, body: json, raw: text, headers: res.headers };
}

function getContainerEnv(varName) {
  try {
    const out = execFileSync(
      'docker',
      ['exec', CONTAINER_BACKEND, 'sh', '-c', `if [ -n "$${varName}" ]; then echo "$${varName}"; elif [ -f /app/.env ]; then grep -E "^${varName}=" /app/.env | head -n1 | cut -d= -f2- | sed 's/^"//;s/"$//'; fi`],
      { encoding: 'utf8' },
    ).trim();
    if (out) return out;
  } catch {}
  const rootEnvPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(rootEnvPath)) {
    const content = fs.readFileSync(rootEnvPath, 'utf8');
    const re = new RegExp(`^${varName}=(.+)$`, 'm');
    const match = content.match(re);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function signTestAdminJwt(adminUser) {
  const secret = getContainerEnv('JWT_SECRET');
  assert.ok(secret, 'No se pudo obtener JWT_SECRET');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: adminUser.id,
      rut: adminUser.rut,
      rol: 'ADMIN',
      email: adminUser.email,
      unidad: adminUser.unidad || 'Departamento de Gestión de Sistemas y TICS',
      dcp: false,
      iat: now,
      exp: now + 300,
      iss: 'municoquimbo-tics-anci',
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  assert.equal(parts.length, 3, 'JWT malformado');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

function limpiarDatosE2E() {
  const sqlStatements = [
    `DELETE FROM telemetria_eventos WHERE codigo_pc = '${TEST_PC}' OR token_id IN (SELECT id FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}') OR metadatos_jsonb::text LIKE '%${TEST_SERIAL}%';`,
    `DELETE FROM estaciones_trabajo WHERE codigo_pc = '${TEST_PC}' OR serial_token_activo = '${TEST_SERIAL}';`,
    `DELETE FROM certificados WHERE numero_serie = 'CERT-${TEST_SERIAL}' OR token_hardware_id IN (SELECT id FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}') OR usuario_id IN (SELECT id FROM usuarios WHERE email IN ('${TEST_EMAIL}', '${TEST_ADMIN_EMAIL}'));`,
    `DELETE FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}';`,
    `DELETE FROM historial_cambios WHERE usuario_email IN ('${TEST_EMAIL}', '${TEST_ADMIN_EMAIL}') OR registro_id IN ('${TEST_SERIAL}', '${TEST_ADMIN_RUT}');`,
    `DELETE FROM usuarios WHERE email IN ('${TEST_EMAIL}', '${TEST_ADMIN_EMAIL}') OR rut = '${TEST_ADMIN_RUT}';`,
  ];

  for (const sql of sqlStatements) {
    psqlScalar(sql);
  }

  redisCmd(
    'DEL',
    `pc:status:${TEST_PC}`,
    `token:cert_meta:${TEST_SERIAL}`,
    `token:connected_at:${TEST_PC}`,
    `user:totp-enrolled:${TEST_ADMIN_RUT}`,
    `user:totp-secret:${TEST_ADMIN_RUT}`,
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
  console.log('=== INICIO SUITE E2E INTEGRIDAD SISTEMA MONITOREO DE TOKENS ===');

  const baselineCounts = {
    usuarios: Number(psqlScalar('SELECT COUNT(*) FROM usuarios;')),
    tokens: Number(psqlScalar('SELECT COUNT(*) FROM tokens_hardware;')),
    certificados: Number(psqlScalar('SELECT COUNT(*) FROM certificados;')),
    estaciones: Number(psqlScalar('SELECT COUNT(*) FROM estaciones_trabajo;')),
    eventos: Number(psqlScalar('SELECT COUNT(*) FROM telemetria_eventos;')),
    historial: Number(psqlScalar('SELECT COUNT(*) FROM historial_cambios;')),
  };
  console.log('Conteo inicial PostgreSQL:', JSON.stringify(baselineCounts));

  const adminRow = psqlScalar(
    "SELECT id || '|' || rut || '|' || email || '|' || unidad FROM usuarios WHERE rol = 'ADMIN' AND estado = 'ACTIVO' ORDER BY created_at ASC LIMIT 1;",
  );
  assert.ok(adminRow, 'No se encontró usuario ADMIN activo en PostgreSQL');
  const [adminId, adminRut, adminEmail, adminUnidad] = adminRow.split('|');
  const adminJwt = signTestAdminJwt({ id: adminId, rut: adminRut, email: adminEmail, unidad: adminUnidad });
  const expectedTotpIssuer =
    getContainerEnv('TOTP_ISSUER') || 'Gestion de tokens - I.Municipalidad de Coquimbo';

  // -------------------------------------------------------------------------
  // 1. Integridad DB & dist (sin seeds demo, sin módulos eliminados, superadmins activos)
  // -------------------------------------------------------------------------
  await runTest(
    '1.1',
    'Contenedor /app/dist/ limpio (sin seeds demo ni módulos eliminados)',
    async () => {
      const grepDemo = spawnSync(
        'docker',
        ['exec', CONTAINER_BACKEND, 'grep', '-rn', 'SN-0529-CQM', '/app/dist/'],
        { encoding: 'utf8' },
      );
      assert.equal(grepDemo.status, 1, 'Se encontraron seeds demo SN-0529-CQM en /app/dist/');

      const checkRemoved = spawnSync(
        'docker',
        ['exec', CONTAINER_BACKEND, 'sh', '-c', 'ls -d /app/dist/firmas /app/dist/equipamiento /app/dist/integraciones 2>/dev/null || true'],
        { encoding: 'utf8' },
      );
      assert.equal((checkRemoved.stdout || '').trim(), '', `Aún existen carpetas eliminadas en dist: ${checkRemoved.stdout}`);

      return '0 seeds demo y 0 módulos fuera de alcance en /app/dist/';
    },
  );

  await runTest(
    '1.2',
    'PostgreSQL íntegro (sin demos, superadmins activos)',
    async () => {
      const demoTokensCount = Number(
        psqlScalar(
          "SELECT COUNT(*) FROM tokens_hardware WHERE serial_number LIKE 'SN-0529-CQM-%' OR serial_number LIKE 'SN-08E6-CQM-%' OR serial_number LIKE 'SN-096E-CQM-%' OR serial_number LIKE 'SN-0DC3-CQM-%';",
        ),
      );
      assert.equal(demoTokensCount, 0, `Tokens demo residuales: ${demoTokensCount}`);

      const demoStationsCount = Number(
        psqlScalar("SELECT COUNT(*) FROM estaciones_trabajo WHERE codigo_pc LIKE 'PC-SECMUN-%';"),
      );
      assert.equal(demoStationsCount, 0, `Estaciones demo residuales: ${demoStationsCount}`);

      const admins = psqlLines("SELECT rut || ':' || estado FROM usuarios WHERE rol = 'ADMIN' AND estado = 'ACTIVO' ORDER BY rut;");
      assert.ok(admins.length >= 1, 'Debe existir al menos un ADMIN activo');

      return `adminsActivos=${admins.join(', ')}`;
    },
  );

  // -------------------------------------------------------------------------
  // 2 & 3. Login + MFA TOTP (TOTP_ISSUER) + Sesión 3h + Generador/Revocación Admin
  // -------------------------------------------------------------------------
  try {
    await runTest(
      '2.1',
      'MFA TOTP setup (GET /auth/totp/setup) verifica TOTP_ISSUER parametrizado',
      async () => {
        const totpRes = await httpJson('/api/v1/auth/totp/setup', {
          headers: { Authorization: `Bearer ${adminJwt}` },
        });
        assert.equal(totpRes.status, 200, `GET /auth/totp/setup devolvió ${totpRes.status}`);
        assert.equal(totpRes.body?.emisor, expectedTotpIssuer);
        assert.ok(decodeURIComponent(totpRes.body?.otpauthUrl || '').includes(expectedTotpIssuer));
        assert.match(String(totpRes.body?.codigoActual || ''), /^\d{6}$/);
        return `emisor="${totpRes.body.emisor}"`;
      },
    );

    await runTest(
      '3.1',
      'Generar admin -> login PIN + cambio + MFA TOTP + sesión 3h -> revocar -> bloqueo inmediato /login y /me',
      async () => {
        // Generar credenciales admin
        const genRes = await httpJson('/api/v1/usuarios/admins/generar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminJwt}`,
          },
          body: JSON.stringify({
            rut: TEST_ADMIN_RUT,
            nombre: TEST_ADMIN_NOMBRE,
            email: TEST_ADMIN_EMAIL,
            pinInicial: TEST_ADMIN_PIN_INIT,
          }),
        });
        assert.ok(genRes.status === 200 || genRes.status === 201, `POST /admins/generar status=${genRes.status}: ${genRes.raw}`);
        const genUserId = genRes.body?.usuario?.id;
        assert.ok(genUserId, 'Falta id del administrador generado');
        assert.equal(genRes.body?.credenciales?.pinInicial, TEST_ADMIN_PIN_INIT);

        // Login inicial (debeCambiarPassword=true)
        const loginInit = await httpJson('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rut: TEST_ADMIN_RUT, password: TEST_ADMIN_PIN_INIT }),
        });
        assert.equal(loginInit.status, 200, `Login inicial falló: ${loginInit.raw}`);
        assert.equal(loginInit.body?.expiresIn, 10800, 'Sesión debe expirar en 3h (10800s)');
        assert.equal(loginInit.body?.debeCambiarPassword, true);
        assert.equal(loginInit.body?.totpSetup?.emisor, expectedTotpIssuer);
        const totpCode = loginInit.body?.totpSetup?.codigoActual;
        assert.match(String(totpCode || ''), /^\d{6}$/);

        // Cambio de PIN + verificación MFA TOTP
        const changeRes = await httpJson('/api/v1/auth/cambiar-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${loginInit.body.accessToken}`,
          },
          body: JSON.stringify({
            passwordActual: TEST_ADMIN_PIN_INIT,
            passwordNueva: TEST_ADMIN_PIN_NEW,
            codigoTotp: totpCode,
          }),
        });
        assert.equal(changeRes.status, 200, `Cambio de PIN falló: ${changeRes.raw}`);
        assert.equal(changeRes.body?.debeCambiarPassword, false);

        // Login con nuevo PIN sin TOTP -> exige MFA
        const loginMfaChallenge = await httpJson('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rut: TEST_ADMIN_RUT, password: TEST_ADMIN_PIN_NEW }),
        });
        assert.equal(loginMfaChallenge.status, 200);
        assert.equal(loginMfaChallenge.body?.requiereMfa, true);

        // Login con nuevo PIN + TOTP -> emite JWT 3h
        const loginFull = await httpJson('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rut: TEST_ADMIN_RUT,
            password: TEST_ADMIN_PIN_NEW,
            codigoTotp: totpCode,
          }),
        });
        assert.equal(loginFull.status, 200, `Login MFA falló: ${loginFull.raw}`);
        assert.equal(loginFull.body?.expiresIn, 10800);
        const genJwt = loginFull.body?.accessToken;
        const claims = decodeJwtPayload(genJwt);
        assert.equal(claims.exp - claims.iat, 10800, 'JWT exp - iat debe ser exactamente 10800s (3h)');

        // GET /auth/me activo antes de revocar
        const meBefore = await httpJson('/api/v1/auth/me', {
          headers: { Authorization: `Bearer ${genJwt}` },
        });
        assert.equal(meBefore.status, 200);
        assert.equal(meBefore.body?.rut, TEST_ADMIN_RUT);

        // Revocar administrador
        const revRes = await httpJson(`/api/v1/usuarios/admins/${genUserId}/revocar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminJwt}` },
        });
        assert.ok(revRes.status === 200 || revRes.status === 201, `Revocación falló: ${revRes.raw}`);

        // Bloqueo inmediato en /auth/me y /auth/login
        const meAfter = await httpJson('/api/v1/auth/me', {
          headers: { Authorization: `Bearer ${genJwt}` },
        });
        assert.equal(meAfter.status, 401, `Esperado 401 en /me tras revocar, recibido ${meAfter.status}`);

        const loginAfter = await httpJson('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rut: TEST_ADMIN_RUT, password: TEST_ADMIN_PIN_NEW, codigoTotp: totpCode }),
        });
        assert.ok(
          loginAfter.status === 401 || loginAfter.status === 403,
          `Esperado 401/403 en /login tras revocar, recibido ${loginAfter.status}`,
        );

        return `generado=${TEST_ADMIN_RUT}, sesion=10800s (3h), MFA=OK, revocado->/me=401 & /login=${loginAfter.status}`;
      },
    );

    // -----------------------------------------------------------------------
    // 4. Ciclo Ghost App (CONECTADO UTF-8 -> /estaciones y /metricas -> DESCONECTADO conservando ultimaIp)
    // -----------------------------------------------------------------------
    await runTest(
      '4.1',
      'Ciclo Ghost App CONECTADO UTF-8 -> /estaciones & /metricas -> DESCONECTADO conserva ultimaIp',
      async () => {
        const connectRes = await httpJson('/api/v1/telemetria/usb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
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
          }),
        });
        assert.equal(connectRes.status, 200);
        assert.equal(connectRes.body?.estadoHardware, 'CONECTADO');

        const dbNombre = psqlScalar(`SELECT nombre FROM usuarios WHERE email = '${TEST_EMAIL}';`);
        assert.equal(dbNombre, TEST_NOMBRE, `UTF-8 corrupto en BD: "${dbNombre}"`);

        const estRes = await httpJson('/api/v1/telemetria/estaciones');
        assert.equal(estRes.status, 200);
        const est = estRes.body.find((e) => e.codigoPc === TEST_PC);
        assert.ok(est && est.estadoEnVivo === 'CONECTADO' && est.tokenInfo?.titularNombre === TEST_NOMBRE);

        const metConn = await httpJson('/api/v1/telemetria/metricas?modo=ULTIMOS_30_DIAS');
        assert.equal(metConn.status, 200);
        const dispConn = metConn.body?.telemetria?.trazabilidadDispositivos?.find((d) => d.serialNumber === TEST_SERIAL);
        assert.ok(dispConn && dispConn.estadoEnVivo === 'CONECTADO' && dispConn.ultimaIp === TEST_IP);

        const discRes = await httpJson('/api/v1/telemetria/usb', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            codigoPc: TEST_PC,
            estadoHardware: 'DESCONECTADO',
            timestamp: new Date().toISOString(),
            metadatos: { previousSerialNumber: TEST_SERIAL, stateChanged: true, isHeartbeat: false },
          }),
        });
        assert.equal(discRes.status, 200);
        assert.equal(discRes.body?.estadoHardware, 'DESCONECTADO');

        const metDisc = await httpJson('/api/v1/telemetria/metricas?modo=ULTIMOS_30_DIAS');
        assert.equal(metDisc.status, 200);
        const dispDisc = metDisc.body?.telemetria?.trazabilidadDispositivos?.find((d) => d.serialNumber === TEST_SERIAL);
        assert.ok(dispDisc, 'Dispositivo E2E desapareció tras desconexión');
        assert.equal(dispDisc.estadoEnVivo, 'DESCONECTADO');
        assert.equal(dispDisc.ultimaIp, TEST_IP);

        return `UTF-8="${dbNombre}", CONECTADO->DESCONECTADO, ultimaIp=${dispDisc.ultimaIp}`;
      },
    );
  } finally {
    await runTest(
      '4.2',
      'Limpieza post-test (admin temporal + telemetría E2E en PostgreSQL y Redis)',
      async () => {
        limpiarDatosE2E();
        const rem = Number(
          psqlScalar(
            `SELECT (SELECT COUNT(*) FROM usuarios WHERE email IN ('${TEST_EMAIL}','${TEST_ADMIN_EMAIL}') OR rut = '${TEST_ADMIN_RUT}') + (SELECT COUNT(*) FROM tokens_hardware WHERE serial_number = '${TEST_SERIAL}') + (SELECT COUNT(*) FROM estaciones_trabajo WHERE codigo_pc = '${TEST_PC}');`,
          ),
        );
        assert.equal(rem, 0, `Quedaron ${rem} registros residuales`);
        const redisKeysRaw = redisCmd('KEYS', '*');
        assert.ok(!redisKeysRaw.includes(TEST_PC) && !redisKeysRaw.includes(TEST_SERIAL) && !redisKeysRaw.includes(TEST_ADMIN_RUT));
        return '0 residuos en PostgreSQL y Redis';
      },
    );
  }

  // -------------------------------------------------------------------------
  // 5. Métricas en los 6 períodos
  // -------------------------------------------------------------------------
  await runTest(
    '5.1',
    'Métricas en los 6 períodos (7d, 15d, 30d, 60d, POR_MES, POR_ANIO)',
    async () => {
      const modos = [
        'ULTIMOS_7_DIAS',
        'ULTIMOS_15_DIAS',
        'ULTIMOS_30_DIAS',
        'ULTIMOS_60_DIAS',
        'POR_MES',
        'POR_ANIO',
      ];
      const summary = [];
      for (const modo of modos) {
        const res = await httpJson(`/api/v1/telemetria/metricas?modo=${encodeURIComponent(modo)}`);
        assert.equal(res.status, 200, `Modo ${modo} devolvió ${res.status}`);
        const d = res.body;
        assert.equal(d.periodo?.modo, modo);
        assert.equal(d.firmas, undefined, 'El bloque obsoleto "firmas" no debe existir');
        assert.equal(typeof d.telemetria?.promedioUsoDiarioGeneralMinutos, 'number');
        assert.equal(typeof d.telemetria?.tiempoUsoTotalMinutos, 'number');
        assert.ok(Array.isArray(d.firmasAsignadas?.listado));
        for (const item of d.firmasAsignadas.listado) {
          assert.equal(typeof item.promedioUsoDiarioMinutos, 'number');
        }
        assert.ok(Array.isArray(d.serieTemporal) && d.serieTemporal.length > 0);
        summary.push(`${modo}(dias=${d.serieTemporal.length})`);
      }
      return summary.join(', ');
    },
  );

  // -------------------------------------------------------------------------
  // 6. Descarga del agente Ghost App limpio
  // -------------------------------------------------------------------------
  await runTest(
    '6.1',
    'GET /api/v1/telemetria/descargar-agente entrega payload limpio sin código de firma PKCS7',
    async () => {
      const res = await httpJson('/api/v1/telemetria/descargar-agente?formato=autoinstalador');
      assert.equal(res.status, 200, `Status inesperado: ${res.status}`);
      const bat = res.raw || '';
      assert.ok(bat.includes('CoquimboGhostApp'), 'El autoinstalador no contiene CoquimboGhostApp');

      const regex = /FromBase64String\('([^']+)'\);\s*\$stream\s*=\s*\[IO\.File\]::Open\('%INSTALL_DIR%\\main\.js'/g;
      const decodedChunks = [];
      let m;
      while ((m = regex.exec(bat)) !== null) {
        decodedChunks.push(Buffer.from(m[1], 'base64'));
      }
      assert.ok(decodedChunks.length > 0, 'No se encontraron chunks Base64 de main.js');
      const mainJs = Buffer.concat(decodedChunks).toString('utf8');

      assert.ok(mainJs.includes('listarCertificadosTokenWindows'), 'Falta lectura de certificados Windows');
      assert.ok(mainJs.includes('validarRutModulo11'), 'Falta validación RUT módulo 11');
      assert.ok(!mainJs.includes('firmarPkcs7ConTokenWindows'), 'main.js aún contiene firmarPkcs7ConTokenWindows');
      assert.ok(!mainJs.includes('startLocalTokenSigningBridge'), 'main.js aún contiene startLocalTokenSigningBridge');
      assert.ok(!mainJs.includes('KNOWN_TOKEN_CERT_HOLDERS'), 'main.js aún contiene KNOWN_TOKEN_CERT_HOLDERS');

      return `chunks=${decodedChunks.length}, mainJs=${mainJs.length} bytes (limpio)`;
    },
  );

  // -------------------------------------------------------------------------
  // 7. Plantilla de correo de caducidad y preview
  // -------------------------------------------------------------------------
  await runTest(
    '7.1',
    'Preview correo caducidad (POST /usuarios/alertas-vencimiento/despachar soloPreview=true)',
    async () => {
      const dummyRut = '19.876.543-2';
      const res = await httpJson('/api/v1/usuarios/alertas-vencimiento/despachar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${adminJwt}`,
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
      assert.ok(res.body?.htmlCorreo?.includes('Oficina de Transformación Digital'));
      assert.ok(res.body?.htmlCorreo?.includes('+569 91682880'));
      assert.ok(res.body?.htmlCorreo?.includes('Camila Constanza Herrera Pastén'));
      assert.ok(!res.body?.htmlCorreo?.includes(dummyRut), 'HTML filtró RUT');
      assert.ok(!res.body?.cuerpoCorreo?.includes(dummyRut), 'TEXT filtró RUT');
      assert.match(res.body.htmlCorreo, /<b>RUT:<\/b><\/td>\s*<td[^>]*>&nbsp;<\/td>/);
      assert.match(res.body.cuerpoCorreo, /^RUT:\s*$/m);

      return `remitente="${res.body.remitenteSmtp}", RUT omitido OK, oficina y teléfono OK`;
    },
  );

  // -------------------------------------------------------------------------
  // 8. Auditoría
  // -------------------------------------------------------------------------
  await runTest(
    '8.1',
    'Bitácora de auditoría (GET /api/v1/auditoria y /estadisticas)',
    async () => {
      const listRes = await httpJson('/api/v1/auditoria', {
        headers: { Authorization: `Bearer ${adminJwt}` },
      });
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.body));

      const statsRes = await httpJson('/api/v1/auditoria/estadisticas', {
        headers: { Authorization: `Bearer ${adminJwt}` },
      });
      assert.equal(statsRes.status, 200);
      assert.equal(typeof statsRes.body?.eventosAuditados, 'number');

      return `registros=${listRes.body.length}, totalAuditados=${statsRes.body.eventosAuditados}`;
    },
  );

  // -------------------------------------------------------------------------
  // 9. Conteo final PostgreSQL idéntico al inicial (0 residuos E2E)
  // -------------------------------------------------------------------------
  let finalCounts = {};
  await runTest(
    '9.1',
    'Conteo final PostgreSQL idéntico al inicial (0 residuos E2E)',
    async () => {
      finalCounts = {
        usuarios: Number(psqlScalar('SELECT COUNT(*) FROM usuarios;')),
        tokens: Number(psqlScalar('SELECT COUNT(*) FROM tokens_hardware;')),
        certificados: Number(psqlScalar('SELECT COUNT(*) FROM certificados;')),
        estaciones: Number(psqlScalar('SELECT COUNT(*) FROM estaciones_trabajo;')),
        eventos: Number(psqlScalar('SELECT COUNT(*) FROM telemetria_eventos;')),
        historial: Number(psqlScalar('SELECT COUNT(*) FROM historial_cambios;')),
      };

      assert.deepEqual(finalCounts, baselineCounts, `Conteo cambió: inicial=${JSON.stringify(baselineCounts)} vs final=${JSON.stringify(finalCounts)}`);
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

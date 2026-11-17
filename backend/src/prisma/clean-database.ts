/**
 * SCRIPT DE LIMPIEZA PROFUNDA DE BASE DE DATOS (BASE DE 0)
 * Ilustre Municipalidad de Coquimbo
 *
 * Elimina todos los datos de prueba, registros y telemetría,
 * dejando la base de datos en estado CERO con únicamente el Administrador inicial
 * para que el usuario pueda poblar sus propios datos reales.
 *
 * Ejecución:
 *   npm run db:clean (desde backend/)
 */

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// Cargar variables de .env si no estan presentes en process.env
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const databaseUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres123@localhost:5432/gestion_firmas?schema=public';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

async function cleanDatabase() {
  console.log('========================================================================');
  console.log('  INICIANDO LIMPIEZA DE BASE DE DATOS - ESTADO CERO (MUNI COQUIMBO)');
  console.log('========================================================================');

  try {
    // 1. Limpieza de tablas dependientes y relacionales en orden
    console.log('[1/4] Eliminando eventos de telemetría y auditoría...');
    await prisma.telemetriaEvento.deleteMany({});
    await prisma.historialCambio.deleteMany({});

    console.log('[2/4] Eliminando actas de custodia y solicitudes de firma...');
    await prisma.actaCustodia.deleteMany({});
    await prisma.solicitudFirma.deleteMany({});

    console.log('[3/4] Eliminando certificados, tokens, estaciones e integraciones...');
    await prisma.certificado.deleteMany({});
    await prisma.tokenHardware.deleteMany({});
    await prisma.estacionTrabajo.deleteMany({});
    await prisma.integracionApi.deleteMany({});

    console.log('[4/4] Eliminando usuarios anteriores...');
    await prisma.usuario.deleteMany({});

    // 2. Limpieza de caché de presencia en Redis
    try {
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        lazyConnect: true,
        connectTimeout: 2000,
      });
      await redis.connect();
      const keys = await redis.keys('pc:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await redis.quit();
      console.log(`[Redis] Limpiadas ${keys.length} presencias de telemetría en caché.`);
    } catch (redisErr) {
      console.warn('[Redis] No se pudo limpiar Redis (servidor no disponible o local):', (redisErr as Error).message);
    }

    // 3. Crear el Administrador Inicial
    const { hashSecret, generarPasswordTemporal, generarPin } = await import('../common/crypto.util');
    const rutAdmin = process.env.ADMIN_INICIAL_RUT || '21.374.808-4';
    const nombreAdmin = process.env.ADMIN_INICIAL_NOMBRE || 'Daniel Alejandro Trigo Tabilo';
    const emailAdmin = (process.env.ADMIN_INICIAL_EMAIL || 'daniel.trigo@alumnos.ucn.cl').toLowerCase();
    const cargoAdmin = process.env.ADMIN_INICIAL_CARGO || 'Administrador General de Sistemas';
    const unidadAdmin = process.env.ADMIN_INICIAL_UNIDAD || 'Departamento de Gestión de Sistemas y TICS';

    const passAdmin = process.env.ADMIN_INICIAL_PASSWORD || generarPasswordTemporal();
    const pinAdmin = process.env.ADMIN_INICIAL_PIN || generarPin();

    const admin = await prisma.usuario.create({
      data: {
        rut: rutAdmin,
        nombre: nombreAdmin,
        email: emailAdmin,
        passwordHash: hashSecret(passAdmin),
        cargo: cargoAdmin,
        unidad: unidadAdmin,
        rol: 'ADMIN',
        estado: 'ACTIVO',
        pinHash: hashSecret(pinAdmin),
        debeCambiarPassword: true,
      },
    });

    console.log('========================================================================');
    console.log('[EXITO] Base de datos restablecida a CERO con éxito.');
    console.log('No quedan datos hardcodeados ni de prueba.');
    console.log('Administrador inicial configurado:');
    console.log(`  - RUT:                 ${admin.rut}`);
    console.log(`  - Nombre:              ${admin.nombre}`);
    console.log(`  - Email:               ${admin.email}`);
    console.log(`  - Contraseña temporal: ${passAdmin}`);
    console.log(`  - PIN Token:           ${pinAdmin}`);
    console.log(`  - Rol:                 ${admin.rol}`);
    console.log('  Se exigirá cambiar la contraseña en el primer inicio de sesión.');
    console.log('========================================================================');
  } catch (error) {
    console.error('[ERROR CRITICO] Ocurrio un error al limpiar la base de datos:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

cleanDatabase();

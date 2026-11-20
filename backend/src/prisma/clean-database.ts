// Restablece la base de datos a estado inicial (ejecución manual: npm run db:clean)

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { hashSecret, generarPasswordTemporal, generarPin } from '../common/crypto.util';
import { formatRut } from '../common/rut.util';

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
  datasources: { db: { url: databaseUrl } },
});

async function cleanDatabase() {
  try {
    const rutRaw = process.env.ADMIN_INICIAL_RUT?.trim();
    const nombreAdmin = process.env.ADMIN_INICIAL_NOMBRE?.trim();
    const emailAdmin = process.env.ADMIN_INICIAL_EMAIL?.trim().toLowerCase();

    if (!rutRaw || !nombreAdmin || !emailAdmin) {
      throw new Error(
        'Defina ADMIN_INICIAL_RUT, ADMIN_INICIAL_NOMBRE y ADMIN_INICIAL_EMAIL en .env antes de ejecutar db:clean.',
      );
    }

    await prisma.telemetriaEvento.deleteMany({});
    await prisma.historialCambio.deleteMany({});
    await prisma.certificado.deleteMany({});
    await prisma.tokenHardware.deleteMany({});
    await prisma.estacionTrabajo.deleteMany({});
    await prisma.usuario.deleteMany({});

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
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
      console.log(`[Redis] Limpiadas ${keys.length} presencias.`);
    } catch (redisErr) {
      console.warn('[Redis] No disponible para limpieza:', (redisErr as Error).message);
    }

    const rutAdmin = formatRut(rutRaw) || rutRaw;
    const cargoAdmin = process.env.ADMIN_INICIAL_CARGO || 'Administrador de Sistemas';
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
        debeCambiarPassword: !process.env.ADMIN_INICIAL_PASSWORD,
      },
    });

    console.log(`[OK] Base restablecida. Admin inicial: ${admin.rut} (${admin.email})`);
  } catch (error) {
    console.error('[ERROR] Error al limpiar base de datos:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

cleanDatabase();

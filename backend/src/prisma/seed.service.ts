import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from '../redis/redis.service';
import { hashSecret, generarPasswordTemporal, generarPin } from '../common/crypto.util';
import { formatRut } from '../common/rut.util';

interface ExtraSuperadminConfig {
  rut: string;
  nombre: string;
  email: string;
  cargo?: string;
  unidad?: string;
  pinInicial?: string;
}

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    await this.asegurarIndicesGin();
    await this.asegurarAdminInicial();
    await this.asegurarSuperadminsFijos();
    await this.sincronizarRedisInicial();
  }

  async asegurarAdminInicial() {
    try {
      const adminsActivos = await this.prisma.usuario.count({ where: { rol: 'ADMIN' } });
      if (adminsActivos > 0) return;

      const rutAdminRaw = process.env.ADMIN_INICIAL_RUT;
      const nombreAdmin = process.env.ADMIN_INICIAL_NOMBRE;
      const emailAdmin = process.env.ADMIN_INICIAL_EMAIL;
      if (!rutAdminRaw || !nombreAdmin || !emailAdmin) {
        this.logger.error(
          'No existe ningún ADMIN y faltan ADMIN_INICIAL_RUT / ADMIN_INICIAL_NOMBRE / ADMIN_INICIAL_EMAIL en el entorno.',
        );
        return;
      }

      const rutAdmin = formatRut(rutAdminRaw.trim()) || rutAdminRaw.trim();
      const cargoAdmin = process.env.ADMIN_INICIAL_CARGO || 'Administrador de Sistemas';
      const unidadAdmin = process.env.ADMIN_INICIAL_UNIDAD || 'Departamento de Gestión de Sistemas y TICS';

      const passwordProvista = process.env.ADMIN_INICIAL_PASSWORD;
      const passwordTemporal = passwordProvista || generarPasswordTemporal();
      const pinTemporal = process.env.ADMIN_INICIAL_PIN || generarPin();
      const debeCambiar = !passwordProvista;

      await this.prisma.usuario.upsert({
        where: { rut: rutAdmin },
        update: {
          rol: 'ADMIN',
          estado: 'ACTIVO',
          passwordHash: hashSecret(passwordTemporal),
          pinHash: hashSecret(pinTemporal),
          debeCambiarPassword: debeCambiar,
        },
        create: {
          rut: rutAdmin,
          nombre: nombreAdmin,
          email: emailAdmin.toLowerCase(),
          passwordHash: hashSecret(passwordTemporal),
          cargo: cargoAdmin,
          unidad: unidadAdmin,
          rol: 'ADMIN',
          estado: 'ACTIVO',
          pinHash: hashSecret(pinTemporal),
          debeCambiarPassword: debeCambiar,
        },
      });

      this.logger.warn(`[ADMIN INICIAL] Creado ${rutAdmin} (${emailAdmin}).`);
    } catch (err) {
      this.logger.warn(`No se pudo verificar o crear administrador inicial: ${(err as Error).message}`);
    }
  }

  async asegurarSuperadminsFijos() {
    const raw = process.env.EXTRA_SUPERADMINS_JSON?.trim();
    if (!raw) return;

    let fijos: ExtraSuperadminConfig[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) fijos = parsed;
    } catch (err) {
      this.logger.warn(`EXTRA_SUPERADMINS_JSON inválido: ${(err as Error).message}`);
      return;
    }

    const defaultOrg = process.env.DEFAULT_ORG_NAME || 'Ilustre Municipalidad de Coquimbo';

    for (const item of fijos) {
      if (!item?.rut || !item?.nombre || !item?.email) continue;
      const rut = formatRut(item.rut.trim()) || item.rut.trim();
      const email = item.email.trim().toLowerCase();
      try {
        const existe = await this.prisma.usuario.findFirst({
          where: { OR: [{ rut }, { email }] },
        });
        if (existe) continue;

        const pin = item.pinInicial?.trim() || generarPin();
        await this.prisma.usuario.create({
          data: {
            rut,
            nombre: item.nombre.trim(),
            email,
            passwordHash: hashSecret(pin),
            pinHash: hashSecret(pin),
            cargo: (item.cargo || 'Administrador de Tokens').trim(),
            unidad: (item.unidad || defaultOrg).trim(),
            rol: 'ADMIN',
            estado: 'ACTIVO',
            debeCambiarPassword: true,
          },
        });
        this.logger.log(`[SUPERADMIN] Cuenta inicial creada (${rut}).`);
      } catch (err) {
        this.logger.warn(`No se pudo verificar superadmin (${rut}): ${(err as Error).message}`);
      }
    }
  }

  async asegurarIndicesGin() {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_telemetria_metadatos_gin ON telemetria_eventos USING GIN (metadatos_jsonb);
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_historial_diff_gin ON historial_cambios USING GIN (diff_jsonb);
      `);
      this.logger.log('Índices GIN JSONB verificados en PostgreSQL');
    } catch (err) {
      this.logger.warn(`No se pudieron crear índices GIN: ${(err as Error).message}`);
    }
  }

  async sincronizarRedisInicial() {
    try {
      const estaciones = await this.prisma.estacionTrabajo.findMany();
      for (const est of estaciones) {
        await this.redis.setPresence(est.codigoPc, est.estadoHardware, 3600);
      }
    } catch {}
  }
}

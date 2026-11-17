import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from '../redis/redis.service';
import { hashSecret, generarPasswordTemporal, generarPin } from '../common/crypto.util';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    await this.asegurarIndicesGin();
    await this.asegurarCatalogoClasificacionEIntegraciones();
    await this.asegurarAdminInicial();
    await this.sincronizarRedisInicial();
  }

  async asegurarCatalogoClasificacionEIntegraciones() {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "clasificacion_informacion" (
          "id" TEXT NOT NULL,
          "nivel" "ClasificacionDocumental" NOT NULL,
          "nombre" TEXT NOT NULL,
          "descripcion_politica" TEXT NOT NULL,
          "requiere_fe_publica" BOOLEAN NOT NULL DEFAULT false,
          "retencion_anios" INTEGER NOT NULL DEFAULT 5,
          "normativa_base" TEXT NOT NULL DEFAULT 'ISO/IEC 27001 - Ley 21.663 ANCI',
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "clasificacion_informacion_pkey" PRIMARY KEY ("id")
        );
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "clasificacion_informacion_nivel_key" ON "clasificacion_informacion"("nivel");
      `);

      const niveles: Array<{
        nivel: 'PUBLICA' | 'INTERNA' | 'CONFIDENCIAL' | 'CRITICA';
        nombre: string;
        descripcionPolitica: string;
        requiereFePublica: boolean;
        retencionAnios: number;
      }> = [
        {
          nivel: 'PUBLICA',
          nombre: 'Información Pública Municipal',
          descripcionPolitica: 'Actos administrativos, ordenanzas y decretos de libre acceso ciudadano bajo Ley N° 20.285.',
          requiereFePublica: false,
          retencionAnios: 5,
        },
        {
          nivel: 'INTERNA',
          nombre: 'Uso Interno Institucional',
          descripcionPolitica: 'Memorándums, circulares y oficios de tramitación interna entre direcciones municipales.',
          requiereFePublica: false,
          retencionAnios: 5,
        },
        {
          nivel: 'CONFIDENCIAL',
          nombre: 'Información Confidencial Reservada',
          descripcionPolitica: 'Sumarios administrativos, datos personales sensibles (Ley N° 19.628) y antecedentes contractuales.',
          requiereFePublica: true,
          retencionAnios: 10,
        },
        {
          nivel: 'CRITICA',
          nombre: 'Infraestructura y Seguridad Crítica ANCI',
          descripcionPolitica: 'Decretos alcaldicios críticos, auditorías de seguridad ANCI (Ley N° 21.663) y custodia criptográfica.',
          requiereFePublica: true,
          retencionAnios: 15,
        },
      ];

      for (const item of niveles) {
        await (this.prisma as any).clasificacionInformacion?.upsert({
          where: { nivel: item.nivel },
          update: {
            nombre: item.nombre,
            descripcionPolitica: item.descripcionPolitica,
            requiereFePublica: item.requiereFePublica,
            retencionAnios: item.retencionAnios,
          },
          create: item,
        }).catch(() => {});
      }
    } catch (err) {
      this.logger.warn(`Aviso al inicializar catálogo clasificacion_informacion: ${(err as Error).message}`);
    }
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
          'No existe ningún ADMIN y faltan ADMIN_INICIAL_RUT / ADMIN_INICIAL_NOMBRE / ADMIN_INICIAL_EMAIL en el entorno. No se puede crear el administrador inicial.',
        );
        return;
      }

      // Normaliza el RUT automáticamente (ej: 213748084 -> 21.374.808-4)
      const { formatRut } = await import('../common/rut.util');
      const rutAdmin = formatRut(rutAdminRaw.trim()) || rutAdminRaw.trim();

      const cargoAdmin = process.env.ADMIN_INICIAL_CARGO || 'Administrador de Sistemas';
      const unidadAdmin = process.env.ADMIN_INICIAL_UNIDAD || 'Departamento de Gestión de Sistemas y TICS';

      const passwordProvista = process.env.ADMIN_INICIAL_PASSWORD;
      const passwordTemporal = passwordProvista || generarPasswordTemporal();
      const pinTemporal = process.env.ADMIN_INICIAL_PIN || generarPin();
      // Si se definió explícitamente en el .env, no forzar cambio obligatorio en el primer login
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

      this.logger.warn('========================================================================');
      this.logger.warn('[ADMIN INICIAL] Administrador creado. ANOTE ESTOS DATOS: SE MUESTRAN UNA SOLA VEZ.');
      this.logger.warn(`  RUT:                 ${rutAdmin}`);
      this.logger.warn(`  Contraseña temporal: ${passwordTemporal}`);
      this.logger.warn(`  PIN token temporal:  ${pinTemporal}`);
      this.logger.warn('  Se exigirá cambiar la contraseña en el primer ingreso.');
      this.logger.warn('========================================================================');
    } catch (err) {
      this.logger.warn(`No se pudo verificar o crear administrador inicial: ${(err as Error).message}`);
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
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_solicitudes_flujo_gin ON solicitudes_firma USING GIN (flujo_visacion_jsonb);
      `);
      this.logger.log('Índices GIN JSONB verificados en PostgreSQL');
    } catch (err) {
      this.logger.warn(`No se pudieron crear índices GIN aún: ${(err as Error).message}`);
    }
  }

  async sincronizarRedisInicial() {
    try {
      const estaciones = await this.prisma.estacionTrabajo.findMany();
      for (const est of estaciones) {
        await this.redis.setPresence(est.codigoPc, est.estadoHardware, 3600);
      }
    } catch {
      // Ignorar si Redis no está disponible
    }
  }
}

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
    await this.asegurarTablaContratosYEntornoTest();
    await this.sincronizarRedisInicial();
  }

  async asegurarTablaContratosYEntornoTest() {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "contratos_tokens" (
          "id" TEXT NOT NULL,
          "codigo_contrato" TEXT NOT NULL,
          "titulo" TEXT NOT NULL,
          "proveedor" TEXT NOT NULL,
          "fecha_inicio" TIMESTAMP(3) NOT NULL,
          "fecha_caducidad" TIMESTAMP(3) NOT NULL,
          "cantidad_tokens" INTEGER NOT NULL DEFAULT 1,
          "monto_referencial" TEXT,
          "descripcion" TEXT,
          "documento_url" TEXT NOT NULL DEFAULT '',
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "contratos_tokens_pkey" PRIMARY KEY ("id")
        );
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "contratos_tokens_codigo_contrato_key" ON "contratos_tokens"("codigo_contrato");
      `);

      const ahora = new Date();
      const countContratos = await this.prisma.contratoToken.count();
      if (countContratos === 0) {
        const contratosSemilla = [
          {
            codigoContrato: 'CON-2025-TOKENS-CQM-01',
            titulo: 'Suministro de Tokens Criptográficos USB FIPS 140-2 Nivel 3 - Lote Principal',
            proveedor: 'E-Sign Chile S.A. / Thales SafeNet',
            fechaInicio: new Date(ahora.getTime() - 280 * 24 * 60 * 60 * 1000),
            fechaCaducidad: new Date(ahora.getTime() + 450 * 24 * 60 * 60 * 1000),
            cantidadTokens: 25,
            montoReferencial: 'OC N° 4291-188-CM25 (UTM 185)',
            descripcion:
              'Contrato anual renovable para provisión de dispositivos eToken 5110 CC y certificados de Firma Electrónica Avanzada.',
            documentoUrl: '/api/v1/equipamiento/contratos/CON-2025-TOKENS-CQM-01/pdf',
          },
          {
            codigoContrato: 'CON-2026-TOKENS-THALES-02',
            titulo: 'Renovación de Tokens Criptográficos IDPrime Direcciones Operativas',
            proveedor: 'Thales Cloud Protection & Licensing / SEGPRES',
            fechaInicio: new Date(ahora.getTime() - 320 * 24 * 60 * 60 * 1000),
            fechaCaducidad: new Date(ahora.getTime() + 38 * 24 * 60 * 60 * 1000),
            cantidadTokens: 15,
            montoReferencial: 'OC N° 4291-512-CM26 (UTM 110)',
            descripcion:
              'Lote complementario de dispositivos criptográficos USB para Secretaría Municipal, Jurídica y Finanzas.',
            documentoUrl: '/api/v1/equipamiento/contratos/CON-2026-TOKENS-THALES-02/pdf',
          },
          {
            codigoContrato: 'CON-2024-TOKENS-ATHENA-03',
            titulo: 'Adquisición Histórica Tokens Athena IDProtect Key v2',
            proveedor: 'Athena Smartcard Solutions / Certinet',
            fechaInicio: new Date(ahora.getTime() - 760 * 24 * 60 * 60 * 1000),
            fechaCaducidad: new Date(ahora.getTime() - 25 * 24 * 60 * 60 * 1000),
            cantidadTokens: 10,
            montoReferencial: 'OC N° 4291-044-CM24 (UTM 75)',
            descripcion:
              'Contrato histórico finalizado de dispositivos Athena IDProtect sujetos a recambio tecnológico.',
            documentoUrl: '/api/v1/equipamiento/contratos/CON-2024-TOKENS-ATHENA-03/pdf',
          },
        ];

        for (const c of contratosSemilla) {
          await this.prisma.contratoToken.upsert({
            where: { codigoContrato: c.codigoContrato },
            update: c,
            create: c,
          });
        }
        this.logger.log('[Entorno Test] Contratos de obtención de tokens inicializados.');
      }

      // Poblar dispositivos, funcionarios, vigencias (15, 30, 60 días, vigentes y expirados) y acciones de firma si no existen tokens
      const countTokens = await this.prisma.tokenHardware.count();
      if (countTokens === 0) {
        const funcionariosTest = [
          {
            rut: '16.892.415-3',
            nombre: 'Juan Pérez González',
            email: 'juan.perez@municoquimbo.cl',
            cargo: 'Analista de Gestión Documental',
            unidad: 'Dirección de Tránsito y Transporte',
            rol: 'FUNCIONARIO' as const,
            serialNumber: 'SN-0529-CQM-8841',
            marca: 'Thales / SafeNet',
            modelo: 'eToken 5110 CC (FIPS 140-2 L3)',
            vendorId: '0x0529',
            diasVigencia: 11, // Umbral <= 15 días (Crítico)
            codigoPc: 'PC-TRANSITO-01',
            firmasRecientes: [0, 1, 2, 4, 6, 10, 18, 25],
          },
          {
            rut: '15.432.890-K',
            nombre: 'María Carolina Rojas Vega',
            email: 'mrojas@municoquimbo.cl',
            cargo: 'Secretaria Abogada Municipal',
            unidad: 'Secretaría Municipal',
            rol: 'MINISTRO_DE_FE' as const,
            serialNumber: 'SN-0529-CQM-9102',
            marca: 'Thales / SafeNet',
            modelo: 'eToken 5110 CC (FIPS 140-2 L3)',
            vendorId: '0x0529',
            diasVigencia: 24, // Umbral <= 30 días (Media)
            codigoPc: 'PC-SECMUN-01',
            firmasRecientes: [0, 1, 1, 3, 5, 8, 12, 14, 21, 28, 42],
          },
          {
            rut: '13.765.112-8',
            nombre: 'Roberto Andrés Morales Silva',
            email: 'rmorales@municoquimbo.cl',
            cargo: 'Jefe de Finanzas y Presupuesto',
            unidad: 'Dirección de Administración y Finanzas',
            rol: 'SUPERVISOR' as const,
            serialNumber: 'SN-08E6-CQM-4410',
            marca: 'Thales / Gemalto',
            modelo: 'IDPrime MD 840 Token USB',
            vendorId: '0x08E6',
            diasVigencia: 48, // Umbral <= 60 días (Preventivo)
            codigoPc: 'PC-DAF-02',
            firmasRecientes: [2, 5, 9, 13, 19, 27],
          },
          {
            rut: '18.210.554-1',
            nombre: 'Camila Alejandra Soto Pizarro',
            email: 'csoto@municoquimbo.cl',
            cargo: 'Asesora Jurídica Municipal',
            unidad: 'Dirección Jurídica',
            rol: 'FUNCIONARIO' as const,
            serialNumber: 'SN-096E-CQM-3305',
            marca: 'Feitian Technologies',
            modelo: 'ePass2003-Auto FIPS',
            vendorId: '0x096E',
            diasVigencia: 215, // Vigente (> 60 días)
            codigoPc: 'PC-JURIDICA-01',
            firmasRecientes: [1, 3, 6, 11, 15, 22, 35],
          },
          {
            rut: '11.998.234-5',
            nombre: 'Héctor Patricio Araya Cortés',
            email: 'haraya@municoquimbo.cl',
            cargo: 'Inspector de Obras Municipales',
            unidad: 'Dirección de Obras Municipales (DOM)',
            rol: 'FUNCIONARIO' as const,
            serialNumber: 'SN-0DC3-CQM-1029',
            marca: 'Athena Smartcard',
            modelo: 'IDProtect Key USB v2',
            vendorId: '0x0DC3',
            diasVigencia: -16, // Expirado
            codigoPc: 'PC-DOM-03',
            firmasRecientes: [20, 26, 50],
          },
        ];

        for (const item of funcionariosTest) {
          const user = await this.prisma.usuario.upsert({
            where: { rut: item.rut },
            update: {
              nombre: item.nombre,
              email: item.email,
              cargo: item.cargo,
              unidad: item.unidad,
              rol: item.rol,
              estado: 'ACTIVO',
            },
            create: {
              rut: item.rut,
              nombre: item.nombre,
              email: item.email,
              cargo: item.cargo,
              unidad: item.unidad,
              rol: item.rol,
              estado: 'ACTIVO',
              passwordHash: hashSecret('Funcionario2026!'),
              pinHash: hashSecret('1234'),
              debeCambiarPassword: false,
            },
          });

          const token = await this.prisma.tokenHardware.upsert({
            where: { serialNumber: item.serialNumber },
            update: {
              vendorId: item.vendorId,
              marca: item.marca,
              modelo: item.modelo,
              estadoPatrimonial: item.diasVigencia < 0 ? 'EN_REVISION' : 'ASIGNADO',
            },
            create: {
              serialNumber: item.serialNumber,
              vendorId: item.vendorId,
              marca: item.marca,
              modelo: item.modelo,
              estadoPatrimonial: item.diasVigencia < 0 ? 'EN_REVISION' : 'ASIGNADO',
            },
          });

          const validoHasta = new Date(ahora.getTime() + item.diasVigencia * 24 * 60 * 60 * 1000);
          const estadoCert =
            item.diasVigencia < 0
              ? 'VENCIDO'
              : item.diasVigencia <= 60
              ? 'POR_VENCER'
              : 'VIGENTE';

          await this.prisma.certificado.create({
            data: {
              numeroSerie: `CERT-FEA-${item.serialNumber.slice(-8)}`,
              usuarioId: user.id,
              tokenHardwareId: token.id,
              tipo: 'FIRMAGOB',
              custodia: 'TOKEN_FISICO',
              validoHasta,
              estado: estadoCert as any,
              createdAt: new Date(ahora.getTime() - 180 * 24 * 60 * 60 * 1000),
            },
          });

          const estadoPc = item.diasVigencia > 0 ? 'CONECTADO' : 'DESCONECTADO';
          await this.prisma.estacionTrabajo.upsert({
            where: { codigoPc: item.codigoPc },
            update: {
              dependenciaFisica: item.unidad,
              estadoHardware: estadoPc as any,
              serialTokenActivo: estadoPc === 'CONECTADO' ? item.serialNumber : null,
              ultimoPing: ahora,
            },
            create: {
              codigoPc: item.codigoPc,
              ipAsignada: `10.10.14.${10 + Math.floor(Math.random() * 80)}`,
              dependenciaFisica: item.unidad,
              estadoHardware: estadoPc as any,
              serialTokenActivo: estadoPc === 'CONECTADO' ? item.serialNumber : null,
              ultimoPing: ahora,
            },
          });

          // Registrar acciones de firma (FIRMANDO) y eventos de conexión/desconexión (CONECTADO/DESCONECTADO)
          for (const diasAtras of item.firmasRecientes) {
            const fechaEv = new Date(
              ahora.getTime() - diasAtras * 24 * 60 * 60 * 1000 - Math.floor(Math.random() * 3600000),
            );
            // Conexión previa del dispositivo (NO cuenta como acción de firma)
            await this.prisma.telemetriaEvento.create({
              data: {
                codigoPc: item.codigoPc,
                tokenId: token.id,
                evento: 'CONECTADO',
                timestamp: new Date(fechaEv.getTime() - 120000),
                metadatosJsonb: {
                  serialNumber: item.serialNumber,
                  usuarioId: user.id,
                  funcionarioRut: user.rut,
                  funcionarioNombre: user.nombre,
                  stateChanged: true,
                },
              },
            });
            // Acción de firma efectiva con el token en sesión (SÍ cuenta como acción de firma)
            await this.prisma.telemetriaEvento.create({
              data: {
                codigoPc: item.codigoPc,
                tokenId: token.id,
                evento: 'FIRMANDO',
                timestamp: fechaEv,
                metadatosJsonb: {
                  accionFirma: true,
                  serialNumber: item.serialNumber,
                  usuarioId: user.id,
                  funcionarioRut: user.rut,
                  funcionarioNombre: user.nombre,
                  unidad: user.unidad,
                  glosaAccion: 'Firma electrónica de documento municipal con token en sesión',
                  stateChanged: true,
                },
              },
            });
          }
        }
        this.logger.log(
          '[Entorno Test] Tokens, firmas asignadas (15/30/60 días, vigentes y expirados) y acciones por funcionario inicializados.',
        );
      }
    } catch (err) {
      this.logger.warn(`Aviso al inicializar datos de control de tokens en entorno test: ${(err as Error).message}`);
    }
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
      const unidadAdmin = process.env.ADMIN_INICIAL_UNIDAD || 'Dirección de TICs';

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

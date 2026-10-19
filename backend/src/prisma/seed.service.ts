import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from '../redis/redis.service';
import * as crypto from 'crypto';

export interface CredencialPrueba {
  rol: string;
  rut: string;
  password: string;
  pinToken: string;
  nombre: string;
  email: string;
  cargo: string;
  unidad: string;
  estado: string;
  vistaInicial: 'ADMIN' | 'FUNCIONARIO';
  descripcionPermisos: string;
}

export const CREDENCIALES_PRUEBA_OFICIALES: CredencialPrueba[] = [
  {
    rol: 'ADMIN',
    rut: '12.894.120-3',
    password: 'AdminCoquimbo2026!',
    pinToken: '1234',
    nombre: 'Patricio Reyes Morales',
    email: 'preyes@municoquimbo.cl',
    cargo: 'Secretario Municipal y Administrador TIC',
    unidad: 'Dirección de TICs y Secretaría Municipal',
    estado: 'ACTIVO',
    vistaInicial: 'ADMIN',
    descripcionPermisos: 'Acceso total: Dashboard Telemetría, Lotes BullMQ, Usuarios/RRHH, Custodia USB, Alertas, Auditoría JSONB y Configuración Root.',
  },
  {
    rol: 'SUPERVISOR',
    rut: '14.120.932-5',
    password: 'SuperCoquimbo2026!',
    pinToken: '2580',
    nombre: 'Marcela Vega Contreras',
    email: 'mvega@municoquimbo.cl',
    cargo: 'Jefa de Oficina de Partes y Archivo',
    unidad: 'Dirección de Administración y Finanzas (DAF)',
    estado: 'ACTIVO',
    vistaInicial: 'ADMIN',
    descripcionPermisos: 'Supervisión en tiempo real de estaciones USB, despacho de lotes de firma, alertas de certificados y bandeja documental.',
  },
  {
    rol: 'MINISTRO_DE_FE',
    rut: '11.554.218-1',
    password: 'MinistroCoquimbo2026!',
    pinToken: '9999',
    nombre: 'Eugenio Gómez Díaz',
    email: 'egomez@municoquimbo.cl',
    cargo: 'Ministro de Fe Suplente',
    unidad: 'Asesoría Jurídica y Secretaría Municipal',
    estado: 'ACTIVO',
    vistaInicial: 'FUNCIONARIO',
    descripcionPermisos: 'Atestación notarial, otorgamiento de Fe Pública a Decretos Alcaldicios (Ley N° 19.799 Art. 4), bandeja de firmas y Checksign.',
  },
  {
    rol: 'FUNCIONARIO',
    rut: '16.782.341-2',
    password: 'FuncCoquimbo2026!',
    pinToken: '1234',
    nombre: 'Rodrigo Araya Campos',
    email: 'raraya@municoquimbo.cl',
    cargo: 'Analista de Gestión Documental',
    unidad: 'Oficina de Decretos y Resoluciones',
    estado: 'ACTIVO',
    vistaInicial: 'FUNCIONARIO',
    descripcionPermisos: 'Bandeja personal de documentos asignados, firma individual y masiva con PIN de Token USB y portal Checksign.',
  },
  {
    rol: 'FUNCIONARIO',
    rut: '14.112.980-5',
    password: 'FuncCoquimbo2026!',
    pinToken: '4321',
    nombre: 'Marcelo Gómez',
    email: 'mgomez@municoquimbo.cl',
    cargo: 'Director de Obras Municipales',
    unidad: 'Dirección de Obras Municipales (DOM)',
    estado: 'ACTIVO',
    vistaInicial: 'FUNCIONARIO',
    descripcionPermisos: 'Firma de permisos de edificación, resoluciones DOM y licencias de obras con token Feitian ePass2003.',
  },
];

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    await this.asegurarIndicesGin();
    await this.ejecutarSeedInicial();
  }

  async asegurarIndicesGin() {
    try {
      // Índices GIN para columnas JSONB según especificación ARQUITECHTURE.md Sección 2.3
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_telemetria_metadatos_gin ON telemetria_eventos USING GIN (metadatos_jsonb);
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_historial_diff_gin ON historial_cambios USING GIN (diff_jsonb);
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_solicitudes_flujo_gin ON solicitudes_firma USING GIN (flujo_visacion_jsonb);
      `);
      this.logger.log('Índices GIN JSONB verificados en PostgreSQL (telemetria_eventos, historial_cambios, solicitudes_firma)');
    } catch (err) {
      this.logger.warn(`No se pudieron crear índices GIN aún: ${(err as Error).message}`);
    }
  }

  async ejecutarSeedInicial(forzar = false) {
    try {
      const countUsuarios = await this.prisma.usuario.count();
      if (countUsuarios > 0 && !forzar) {
        this.logger.log(`Base de datos ya inicializada (${countUsuarios} usuarios registrados). Sincronizando caché de presencia Redis...`);
        await this.sincronizarRedisInicial();
        return { seeded: false, countUsuarios };
      }

      this.logger.log('Sembrando Base de Datos de Prueba (Entorno Desarrollo/Testing - Municipalidad de Coquimbo)...');

      // 1. Tokens Criptográficos USB (Inventario Patrimonial)
      const tokenSafenet1 = await this.prisma.tokenHardware.upsert({
        where: { serialNumber: 'SN-SAF-98214' },
        update: {},
        create: {
          serialNumber: 'SN-SAF-98214',
          vendorId: '0x04B9 (SafeNet/Gemalto)',
          marca: 'SafeNet',
          modelo: 'eToken 5110 FIPS',
          estadoPatrimonial: 'ASIGNADO',
        },
      });

      const tokenFeitian1 = await this.prisma.tokenHardware.upsert({
        where: { serialNumber: 'SN-EPASS-4011' },
        update: {},
        create: {
          serialNumber: 'SN-EPASS-4011',
          vendorId: '0x096E (Feitian)',
          marca: 'Feitian',
          modelo: 'ePass2003 Auto',
          estadoPatrimonial: 'ASIGNADO',
        },
      });

      const tokenAthena1 = await this.prisma.tokenHardware.upsert({
        where: { serialNumber: 'SN-ATH-1092' },
        update: {},
        create: {
          serialNumber: 'SN-ATH-1092',
          vendorId: '0x076B (Athena)',
          marca: 'Athena',
          modelo: 'ASECard Crypto',
          estadoPatrimonial: 'ASIGNADO',
        },
      });

      const tokenSafenet2 = await this.prisma.tokenHardware.upsert({
        where: { serialNumber: 'SN-SAF-55410' },
        update: {},
        create: {
          serialNumber: 'SN-SAF-55410',
          vendorId: '0x04B9 (SafeNet/Gemalto)',
          marca: 'SafeNet',
          modelo: 'eToken 5110',
          estadoPatrimonial: 'ASIGNADO',
        },
      });

      await this.prisma.tokenHardware.upsert({
        where: { serialNumber: 'SN-SAF-77102' },
        update: {},
        create: {
          serialNumber: 'SN-SAF-77102',
          vendorId: '0x04B9 (SafeNet/Gemalto)',
          marca: 'SafeNet',
          modelo: 'eToken 5110 Plus',
          estadoPatrimonial: 'OPERATIVO',
        },
      });

      const tokenBaja = await this.prisma.tokenHardware.upsert({
        where: { serialNumber: 'SN-EPASS-1099' },
        update: {},
        create: {
          serialNumber: 'SN-EPASS-1099',
          vendorId: '0x096E (Feitian)',
          marca: 'Feitian',
          modelo: 'ePass2003',
          estadoPatrimonial: 'DADO_DE_BAJA',
        },
      });

      // 2. Usuarios y Funcionarios Municipales
      const usrAdmin = await this.prisma.usuario.upsert({
        where: { rut: '12.894.120-3' },
        update: {},
        create: {
          rut: '12.894.120-3',
          nombre: 'Patricio Reyes Morales',
          email: 'preyes@municoquimbo.cl',
          cargo: 'Secretario Municipal y Administrador TIC',
          unidad: 'Dirección de TICs y Secretaría Municipal',
          rol: 'ADMIN',
          estado: 'ACTIVO',
          passwordHash: 'AdminCoquimbo2026!',
          pinHash: '1234',
          condicionContractual: 'PLANTA',
        },
      });

      const usrSupervisor = await this.prisma.usuario.upsert({
        where: { rut: '14.120.932-5' },
        update: {},
        create: {
          rut: '14.120.932-5',
          nombre: 'Marcela Vega Contreras',
          email: 'mvega@municoquimbo.cl',
          cargo: 'Jefa de Oficina de Partes y Archivo',
          unidad: 'Dirección de Administración y Finanzas (DAF)',
          rol: 'SUPERVISOR',
          estado: 'ACTIVO',
          passwordHash: 'SuperCoquimbo2026!',
          pinHash: '2580',
          condicionContractual: 'PLANTA',
        },
      });

      const usrMinistro = await this.prisma.usuario.upsert({
        where: { rut: '11.554.218-1' },
        update: {},
        create: {
          rut: '11.554.218-1',
          nombre: 'Eugenio Gómez Díaz',
          email: 'egomez@municoquimbo.cl',
          cargo: 'Ministro de Fe Suplente',
          unidad: 'Asesoría Jurídica y Secretaría Municipal',
          rol: 'MINISTRO_DE_FE',
          estado: 'ACTIVO',
          passwordHash: 'MinistroCoquimbo2026!',
          pinHash: '9999',
          condicionContractual: 'PLANTA',
        },
      });

      const usrFuncionario = await this.prisma.usuario.upsert({
        where: { rut: '16.782.341-2' },
        update: {},
        create: {
          rut: '16.782.341-2',
          nombre: 'Rodrigo Araya Campos',
          email: 'raraya@municoquimbo.cl',
          cargo: 'Analista de Gestión Documental',
          unidad: 'Oficina de Decretos y Resoluciones',
          rol: 'FUNCIONARIO',
          estado: 'ACTIVO',
          passwordHash: 'FuncCoquimbo2026!',
          pinHash: '1234',
          condicionContractual: 'CONTRATA',
        },
      });

      const usrDom = await this.prisma.usuario.upsert({
        where: { rut: '14.112.980-5' },
        update: {},
        create: {
          rut: '14.112.980-5',
          nombre: 'Marcelo Gómez',
          email: 'mgomez@municoquimbo.cl',
          cargo: 'Director de Obras',
          unidad: 'Dirección de Obras Municipales',
          rol: 'FUNCIONARIO',
          estado: 'ACTIVO',
          passwordHash: 'FuncCoquimbo2026!',
          pinHash: '4321',
          condicionContractual: 'PLANTA',
        },
      });

      const usrDaf = await this.prisma.usuario.upsert({
        where: { rut: '16.541.228-9' },
        update: {},
        create: {
          rut: '16.541.228-9',
          nombre: 'Andrea Morales C.',
          email: 'amorales@municoquimbo.cl',
          cargo: 'Jefa de Personal',
          unidad: 'Dirección de Administración y Finanzas',
          rol: 'SUPERVISOR',
          estado: 'ACTIVO',
          passwordHash: 'SuperCoquimbo2026!',
          pinHash: '1234',
          condicionContractual: 'PLANTA',
        },
      });

      const usrJuridica = await this.prisma.usuario.upsert({
        where: { rut: '17.842.301-1' },
        update: {},
        create: {
          rut: '17.842.301-1',
          nombre: 'Camila Sepúlveda',
          email: 'csepulveda@municoquimbo.cl',
          cargo: 'Abogada Asesora',
          unidad: 'Dirección Jurídica',
          rol: 'FUNCIONARIO',
          estado: 'ACTIVO',
          passwordHash: 'FuncCoquimbo2026!',
          pinHash: '5678',
          condicionContractual: 'CONTRATA',
        },
      });

      const usrAdq = await this.prisma.usuario.upsert({
        where: { rut: '15.342.119-4' },
        update: {},
        create: {
          rut: '15.342.119-4',
          nombre: 'Carolina Rojas V.',
          email: 'crojas@municoquimbo.cl',
          cargo: 'Supervisora de Compras',
          unidad: 'Departamento de Adquisiciones',
          rol: 'FUNCIONARIO',
          estado: 'EN_LICENCIA',
          passwordHash: 'FuncCoquimbo2026!',
          pinHash: '1111',
          condicionContractual: 'CONTRATA',
        },
      });

      const usrDesvinculado = await this.prisma.usuario.upsert({
        where: { rut: '10.221.443-8' },
        update: {},
        create: {
          rut: '10.221.443-8',
          nombre: 'Roberto Pizarro A.',
          email: 'rpizarro@municoquimbo.cl',
          cargo: 'Ex-Inspector Municipal',
          unidad: 'Dirección de Seguridad Pública',
          rol: 'FUNCIONARIO',
          estado: 'DESVINCULADO',
          passwordHash: 'Bloqueado2026!',
          pinHash: '0000',
          pinBloqueado: true,
          condicionContractual: 'HONORARIOS',
        },
      });

      // 3. Certificados Digitales (Escalas 15, 30, 60 días y vigentes)
      const ahora = Date.now();
      const diaMs = 86400000;

      await this.prisma.certificado.deleteMany({});
      await this.prisma.certificado.createMany({
        data: [
          {
            id: 'CERT-01',
            numeroSerie: '0x4F9B882103AC55E1',
            usuarioId: usrAdmin.id,
            tipo: 'FIRMAGOB',
            custodia: 'TOKEN_FISICO',
            validoHasta: new Date(ahora + 25 * diaMs), // < 30 días (MEDIA)
            estado: 'POR_VENCER',
            tokenHardwareId: tokenSafenet1.id,
          },
          {
            id: 'CERT-02',
            numeroSerie: '0x88A12F0091BC4412',
            usuarioId: usrDaf.id,
            tipo: 'FIRMAGOB',
            custodia: 'TOKEN_FISICO',
            validoHasta: new Date(ahora + 58 * diaMs), // < 60 días (BAJA)
            estado: 'VIGENTE',
            tokenHardwareId: tokenSafenet2.id,
          },
          {
            id: 'CERT-03',
            numeroSerie: '0x11C94E7723DF9001',
            usuarioId: usrDom.id,
            tipo: 'FIRMAGOB',
            custodia: 'TOKEN_FISICO',
            validoHasta: new Date(ahora + 12 * diaMs), // < 15 días (ALTA / CRÍTICO)
            estado: 'POR_VENCER',
            tokenHardwareId: tokenFeitian1.id,
          },
          {
            id: 'CERT-04',
            numeroSerie: '0x72E45A1109CC8210',
            usuarioId: usrJuridica.id,
            tipo: 'ESIGN',
            custodia: 'CLOUD',
            validoHasta: new Date(ahora + 52 * diaMs), // < 60 días (BAJA)
            estado: 'VIGENTE',
          },
          {
            id: 'CERT-05',
            numeroSerie: '0x99B23D8812FA3304',
            usuarioId: usrMinistro.id,
            tipo: 'ESIGN',
            custodia: 'TOKEN_FISICO',
            validoHasta: new Date(ahora + 240 * diaMs),
            estado: 'VIGENTE',
            tokenHardwareId: tokenAthena1.id,
          },
          {
            id: 'CERT-06',
            numeroSerie: '0x55D10C4498EE1120',
            usuarioId: usrFuncionario.id,
            tipo: 'FIRMAGOB',
            custodia: 'TOKEN_FISICO',
            validoHasta: new Date(ahora + 310 * diaMs),
            estado: 'VIGENTE',
            tokenHardwareId: tokenSafenet1.id,
          },
          {
            id: 'CERT-07',
            numeroSerie: '0x33F98A2210BB7741',
            usuarioId: usrSupervisor.id,
            tipo: 'ESIGN',
            custodia: 'CLOUD',
            validoHasta: new Date(ahora + 190 * diaMs),
            estado: 'VIGENTE',
          },
          {
            id: 'CERT-08-REV',
            numeroSerie: '0x00DEAD9912FF0000',
            usuarioId: usrDesvinculado.id,
            tipo: 'FIRMAGOB',
            custodia: 'TOKEN_FISICO',
            validoHasta: new Date(ahora - 5 * diaMs),
            estado: 'REVOCADO',
            tokenHardwareId: tokenBaja.id,
          },
        ],
      });

      // 4. Estaciones de Trabajo Municipales
      const estacionesSeed = [
        {
          codigoPc: 'PC-SECMUN-01',
          ipAsignada: '10.20.1.10',
          dependenciaFisica: 'Secretaría Municipal - Piso 2',
          estadoHardware: 'CONECTADO' as const,
          serialTokenActivo: 'SN-SAF-98214',
        },
        {
          codigoPc: 'PC-SECMUN-02',
          ipAsignada: '10.20.1.12',
          dependenciaFisica: 'Secretaría Municipal - Actas y Decretos',
          estadoHardware: 'DESCONECTADO' as const,
          serialTokenActivo: null,
        },
        {
          codigoPc: 'PC-DOM-05',
          ipAsignada: '10.20.2.45',
          dependenciaFisica: 'Dirección de Obras Municipales',
          estadoHardware: 'FIRMANDO' as const,
          serialTokenActivo: 'SN-EPASS-4011',
        },
        {
          codigoPc: 'PC-ALCALDIA-01',
          ipAsignada: '10.20.0.5',
          dependenciaFisica: 'Despacho Alcaldía',
          estadoHardware: 'CONECTADO' as const,
          serialTokenActivo: 'SN-ATH-1092',
        },
        {
          codigoPc: 'PC-TRANSITO-03',
          ipAsignada: '10.20.3.18',
          dependenciaFisica: 'Dirección de Tránsito - Licencias',
          estadoHardware: 'DESCONECTADO' as const,
          serialTokenActivo: null,
        },
        {
          codigoPc: 'PC-DAF-02',
          ipAsignada: '10.20.1.88',
          dependenciaFisica: 'Administración y Finanzas - Adquisiciones',
          estadoHardware: 'CONECTADO' as const,
          serialTokenActivo: 'SN-SAF-55410',
        },
      ];

      for (const est of estacionesSeed) {
        await this.prisma.estacionTrabajo.upsert({
          where: { codigoPc: est.codigoPc },
          update: {
            ipAsignada: est.ipAsignada,
            dependenciaFisica: est.dependenciaFisica,
            estadoHardware: est.estadoHardware,
            serialTokenActivo: est.serialTokenActivo,
            ultimoPing: new Date(),
          },
          create: {
            codigoPc: est.codigoPc,
            ipAsignada: est.ipAsignada,
            dependenciaFisica: est.dependenciaFisica,
            estadoHardware: est.estadoHardware,
            serialTokenActivo: est.serialTokenActivo,
            ultimoPing: new Date(),
          },
        });
      }

      // 5. Solicitudes de Firma, Bandeja de Funcionarios y Decretos de Fe Pública
      await this.prisma.solicitudFirma.deleteMany({});
      const solicitudesData = [
        {
          id: 'SOL-1001',
          codigoDocumento: 'DEC-ALCALDIA-2026-904',
          titulo: 'Aprobación de fondos de subvención cultural comunal para temporada 2026',
          usuarioSolicitanteId: usrAdmin.id,
          tipoTramite: 'DECRETO_ALCALDICIO',
          clasificacion: 'PUBLICA' as const,
          prioridad: 'URGENTE',
          estacionAsignada: 'PC-SECMUN-01',
          tamanioKb: 412,
          estadoAprobacion: 'PENDIENTE' as const,
          documentoUrl: '/api/v1/firmas/solicitudes/SOL-1001/pdf',
          hashSha256: crypto.createHash('sha256').update('DEC-ALCALDIA-2026-904').digest('hex'),
          estadoFePublica: 'PENDIENTE_VISACION',
          flujoVisacionJsonb: [
            { rut: '12.894.120-3', nombre: 'Patricio Reyes Morales', cargo: 'Secretario Municipal', estado: 'PENDIENTE', orden: 1 },
          ],
        },
        {
          id: 'SOL-1002',
          codigoDocumento: 'CONTRATO-HON-402',
          titulo: 'Contratación a honorarios profesional informático para soporte técnico de redes y ciberseguridad',
          usuarioSolicitanteId: usrDaf.id,
          tipoTramite: 'CONTRATO_HONORARIOS',
          clasificacion: 'INTERNA' as const,
          prioridad: 'ALTA',
          estacionAsignada: 'PC-DAF-02',
          tamanioKb: 284,
          estadoAprobacion: 'EN_VISACION' as const,
          documentoUrl: '/api/v1/firmas/solicitudes/SOL-1002/pdf',
          hashSha256: crypto.createHash('sha256').update('CONTRATO-HON-402').digest('hex'),
          estadoFePublica: 'NO_APLICA',
          flujoVisacionJsonb: [
            { rut: '16.541.228-9', nombre: 'Andrea Morales C.', cargo: 'Jefa de Personal', estado: 'VISADO', orden: 1 },
            { rut: '12.894.120-3', nombre: 'Patricio Reyes Morales', cargo: 'Secretario Municipal', estado: 'PENDIENTE', orden: 2 },
          ],
        },
        {
          id: 'SOL-1003',
          codigoDocumento: 'RES-DOM-88',
          titulo: 'Permiso de edificación y recepción definitiva obra menor sector Centro Coquimbo',
          usuarioSolicitanteId: usrDom.id,
          tipoTramite: 'LICENCIA_OBRAS',
          clasificacion: 'PUBLICA' as const,
          prioridad: 'NORMAL',
          estacionAsignada: 'PC-DOM-05',
          tamanioKb: 1045,
          estadoAprobacion: 'PENDIENTE' as const,
          documentoUrl: '/api/v1/firmas/solicitudes/SOL-1003/pdf',
          hashSha256: crypto.createHash('sha256').update('RES-DOM-88').digest('hex'),
          estadoFePublica: 'PENDIENTE_VISACION',
          flujoVisacionJsonb: [
            { rut: '14.112.980-5', nombre: 'Marcelo Gómez', cargo: 'Director de Obras', estado: 'PENDIENTE', orden: 1 },
          ],
        },
        {
          id: 'SOL-1004',
          codigoDocumento: 'OF-ORD-2026-312',
          titulo: 'Oficio respuesta a requerimiento de Contraloría Regional sobre obras civiles comunales',
          usuarioSolicitanteId: usrFuncionario.id,
          tipoTramite: 'OFICIO_ORDINARIO',
          clasificacion: 'CONFIDENCIAL' as const,
          prioridad: 'ALTA',
          estacionAsignada: 'PC-SECMUN-01',
          tamanioKb: 198,
          estadoAprobacion: 'FIRMADA' as const,
          documentoUrl: '/api/v1/firmas/solicitudes/SOL-1004/pdf',
          documentoFirmadoUrl: '/api/v1/firmas/solicitudes/SOL-1004/pdf',
          hashSha256: crypto.createHash('sha256').update('OF-ORD-2026-312').digest('hex'),
          codigoVerificacion: 'FEA-CQBO-7719-2026',
          codigoRegistroNotarial: 'REG-FE-SECMUN-8841-2026',
          estadoFePublica: 'FE_PUBLICA_OTORGADA',
          tsaTimestamp: new Date(ahora - 3600000 * 5),
          flujoVisacionJsonb: [
            { rut: '16.782.341-2', nombre: 'Rodrigo Araya Campos', cargo: 'Analista Gestión Documental', estado: 'FIRMADO', orden: 1 },
          ],
        },
        {
          id: 'SOL-1005',
          codigoDocumento: 'DEC-EX-2026-551',
          titulo: 'Otorgamiento de patente municipal provisoria para local comercial sector Peñuelas',
          usuarioSolicitanteId: usrAdq.id,
          tipoTramite: 'ORDEN_COMPRA',
          clasificacion: 'INTERNA' as const,
          prioridad: 'NORMAL',
          estacionAsignada: 'PC-DAF-02',
          tamanioKb: 310,
          estadoAprobacion: 'PENDIENTE' as const,
          documentoUrl: '/api/v1/firmas/solicitudes/SOL-1005/pdf',
          hashSha256: crypto.createHash('sha256').update('DEC-EX-2026-551').digest('hex'),
          estadoFePublica: 'PENDIENTE_VISACION',
          flujoVisacionJsonb: [
            { rut: '15.342.119-4', nombre: 'Carolina Rojas V.', cargo: 'Supervisora de Compras', estado: 'PENDIENTE', orden: 1 },
          ],
        },
        {
          id: 'SOL-1006',
          codigoDocumento: 'MEMO-DAF-2026-184',
          titulo: 'Informe presupuestario y visación de gastos operacionales de mantención vial',
          usuarioSolicitanteId: usrFuncionario.id,
          tipoTramite: 'MEMORANDUM',
          clasificacion: 'INTERNA' as const,
          prioridad: 'ALTA',
          estacionAsignada: 'PC-SECMUN-01',
          tamanioKb: 265,
          estadoAprobacion: 'PENDIENTE' as const,
          documentoUrl: '/api/v1/firmas/solicitudes/SOL-1006/pdf',
          hashSha256: crypto.createHash('sha256').update('MEMO-DAF-2026-184').digest('hex'),
          estadoFePublica: 'NO_APLICA',
          flujoVisacionJsonb: [
            { rut: '16.782.341-2', nombre: 'Rodrigo Araya Campos', cargo: 'Analista Gestión Documental', estado: 'PENDIENTE', orden: 1 },
          ],
        },
      ];

      for (const sol of solicitudesData) {
        await this.prisma.solicitudFirma.create({ data: sol });
      }

      // 6. Actas de Custodia de Tokens USB
      await this.prisma.actaCustodia.deleteMany({});
      await this.prisma.actaCustodia.createMany({
        data: [
          {
            id: 'ACTA-01',
            codigoActa: 'ACTA-TIC-2026-001',
            tokenId: tokenSafenet1.id,
            usuarioId: usrAdmin.id,
            tipoActa: 'ENTREGA',
            observaciones: 'Entrega de token criptográfico SafeNet eToken 5110 para firma de Decretos Alcaldicios.',
            hashSha256: crypto.createHash('sha256').update('ACTA-TIC-2026-001').digest('hex'),
            documentoFirmadoUrl: '/api/v1/equipamiento/actas/ACTA-01/pdf',
          },
          {
            id: 'ACTA-02',
            codigoActa: 'ACTA-TIC-2026-002',
            tokenId: tokenFeitian1.id,
            usuarioId: usrDom.id,
            tipoActa: 'ENTREGA',
            observaciones: 'Asignación patrimonial de dispositivo Feitian ePass2003 a Dirección de Obras Municipales.',
            hashSha256: crypto.createHash('sha256').update('ACTA-TIC-2026-002').digest('hex'),
            documentoFirmadoUrl: '/api/v1/equipamiento/actas/ACTA-02/pdf',
          },
          {
            id: 'ACTA-03',
            codigoActa: 'ACTA-TIC-2026-003',
            tokenId: tokenAthena1.id,
            usuarioId: usrMinistro.id,
            tipoActa: 'ENTREGA',
            observaciones: 'Asignación de token Athena ASECard para atestación de Fe Pública Ministerial.',
            hashSha256: crypto.createHash('sha256').update('ACTA-TIC-2026-003').digest('hex'),
            documentoFirmadoUrl: '/api/v1/equipamiento/actas/ACTA-03/pdf',
          },
          {
            id: 'ACTA-04',
            codigoActa: 'ACTA-TIC-2026-004',
            tokenId: tokenBaja.id,
            usuarioId: usrDesvinculado.id,
            tipoActa: 'BAJA',
            observaciones: 'Retiro y baja patrimonial por protocolo RRHH (<48h) tras desvinculación administrativa.',
            hashSha256: crypto.createHash('sha256').update('ACTA-TIC-2026-004').digest('hex'),
            documentoFirmadoUrl: '/api/v1/equipamiento/actas/ACTA-04/pdf',
          },
        ],
      });

      // 7. Eventos de Telemetría Forense
      await this.prisma.telemetriaEvento.deleteMany({});
      await this.prisma.telemetriaEvento.createMany({
        data: [
          {
            codigoPc: 'PC-DOM-05',
            tokenId: tokenFeitian1.id,
            evento: 'FIRMANDO',
            metadatosJsonb: {
              hardware: 'Feitian ePass2003 Auto',
              vendorId: '0x096E',
              serialNumber: 'SN-EPASS-4011',
              proceso: 'FEA_PKCS11_SIGN',
              tsaServer: 'tsa.firma.digital.gob.cl',
            },
          },
          {
            codigoPc: 'PC-SECMUN-01',
            tokenId: tokenSafenet1.id,
            evento: 'CONECTADO',
            metadatosJsonb: {
              hardware: 'SafeNet eToken 5110 FIPS',
              vendorId: '0x04B9',
              serialNumber: 'SN-SAF-98214',
              agenteVersion: '1.1.0-ghost-electron',
            },
          },
          {
            codigoPc: 'PC-ALCALDIA-01',
            tokenId: tokenAthena1.id,
            evento: 'CONECTADO',
            metadatosJsonb: {
              hardware: 'Athena ASECard Crypto',
              vendorId: '0x076B',
              serialNumber: 'SN-ATH-1092',
            },
          },
        ],
      });

      // 8. Historial de Cambios (Audit Trail JSONB inalterable - Ley 21.663 ANCI)
      await this.prisma.historialCambio.deleteMany({});
      await this.prisma.historialCambio.createMany({
        data: [
          {
            id: 'AUD-8821',
            tablaAfectada: 'telemetria_eventos',
            registroId: 'PC-DOM-05',
            accion: 'FIRMA_EJECUTADA',
            usuarioId: usrDom.id,
            usuarioEmail: 'mgomez@municoquimbo.cl',
            ipOrigen: '10.20.2.45',
            diffJsonb: {
              hardware: 'Feitian ePass2003 Auto',
              estado: 'FIRMANDO',
              loteId: 'BATCH-2026-DOM',
              sha256Digest: 'a1f938c9284bd09831a274e2881094cc99123a',
              tsaToken: 'RFC3161_VERIFIED',
            },
          },
          {
            id: 'AUD-8820',
            tablaAfectada: 'estaciones_trabajo',
            registroId: 'PC-SECMUN-01',
            accion: 'UPDATE',
            usuarioId: usrAdmin.id,
            usuarioEmail: 'ghost-app-agent@municoquimbo.cl',
            ipOrigen: '10.20.1.10',
            diffJsonb: {
              estadoHardware: 'CONECTADO',
              vendorId: '0x04B9',
              productId: '0x5110',
              serialNumber: 'SN-SAF-98214',
            },
          },
          {
            id: 'AUD-8819',
            tablaAfectada: 'solicitudes_firma',
            registroId: 'SOL-1004',
            accion: 'FIRMA_EJECUTADA',
            usuarioId: usrFuncionario.id,
            usuarioEmail: 'raraya@municoquimbo.cl',
            ipOrigen: '10.20.1.10',
            diffJsonb: {
              codigoDocumento: 'OF-ORD-2026-312',
              estadoAprobacion: 'FIRMADA',
              codigoVerificacion: 'FEA-CQBO-7719-2026',
              firmanteRut: '16.782.341-2',
            },
          },
          {
            id: 'AUD-8818',
            tablaAfectada: 'usuarios',
            registroId: '10.221.443-8',
            accion: 'DESVINCULACION_RRHH',
            usuarioId: usrAdmin.id,
            usuarioEmail: 'preyes@municoquimbo.cl',
            ipOrigen: '10.20.0.5',
            diffJsonb: {
              protocolo: 'RRHH_MENOS_48H_ANCI',
              estadoAnterior: 'ACTIVO',
              estadoNuevo: 'DESVINCULADO',
              certificadosRevocados: ['CERT-08-REV'],
              pinBloqueado: true,
            },
          },
          {
            id: 'AUD-8817',
            tablaAfectada: 'telemetria_eventos',
            registroId: 'PC-DAF-02',
            accion: 'TELEMETRIA_PING',
            usuarioEmail: 'agent-heartbeat@municoquimbo.cl',
            ipOrigen: '10.20.1.88',
            diffJsonb: {
              latenciaMs: 12,
              ttlRedis: 3600,
              estado: 'HEARTBEAT_OK',
              serialNumber: 'SN-SAF-55410',
            },
          },
        ],
      });

      // 9. Integraciones API Externas
      await this.prisma.integracionApi.upsert({
        where: { servicio: 'FIRMAGOB' },
        update: {},
        create: {
          servicio: 'FIRMAGOB',
          credencialesCifradas: 'AES256:GCM:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          webhookSecret: 'whsec_firmagob_segpres_coquimbo_2026',
          endpointUrl: 'https://api.firma.digital.gob.cl/firma/v2/files/tickets',
          activo: true,
        },
      });

      await this.prisma.integracionApi.upsert({
        where: { servicio: 'ESIGN_CHILE' },
        update: {},
        create: {
          servicio: 'ESIGN_CHILE',
          credencialesCifradas: 'AES256:GCM:4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
          webhookSecret: 'whsec_esign_cloudsigner_coquimbo_2026',
          endpointUrl: 'https://cloudsigner.esign-la.com/api/v1/sign',
          activo: true,
        },
      });

      await this.prisma.integracionApi.upsert({
        where: { servicio: 'CLAVE_UNICA' },
        update: {},
        create: {
          servicio: 'CLAVE_UNICA',
          credencialesCifradas: 'AES256:GCM:ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
          webhookSecret: 'whsec_claveunica_oidc_coquimbo_2026',
          endpointUrl: 'https://accounts.claveunica.gob.cl/openid/authorize',
          activo: true,
        },
      });

      await this.sincronizarRedisInicial();

      this.logger.log('Seed de Base de Datos de Prueba completado exitosamente.');
      return { seeded: true, countUsuarios: 9 };
    } catch (error) {
      this.logger.warn(`Error durante seed inicial: ${(error as Error).message}`);
      return { seeded: false, error: (error as Error).message };
    }
  }

  private async sincronizarRedisInicial() {
    try {
      const estaciones = await this.prisma.estacionTrabajo.findMany();
      for (const est of estaciones) {
        await this.redis.setPresence(est.codigoPc, est.estadoHardware, 3600);
      }
    } catch {
      // Ignorar si Redis o DB no están listos aún
    }
  }
}

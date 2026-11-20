import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashSecret, generarPasswordTemporal, generarPin, validarFortalezaPassword } from '../common/crypto.util';
import { formatRut, getRutVariants } from '../common/rut.util';
import { generarPlantillaCorreoCaducidad } from './correo-aviso.template';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const ROLES_VALIDOS = ['ADMIN', 'SUPERVISOR', 'FUNCIONARIO', 'MINISTRO_DE_FE', 'PENDIENTE'];

function getAdminPrincipalRut(): string | null {
  const raw = process.env.ADMIN_INICIAL_RUT?.trim();
  if (!raw) return null;
  return formatRut(raw) || raw;
}

function getSuperadminsProtegidos(): string[] {
  const ruts = new Set<string>();
  const principal = getAdminPrincipalRut();
  if (principal) ruts.add(principal);

  for (const envVar of [process.env.SUPERADMINS_FIJOS_JSON, process.env.EXTRA_SUPERADMINS_JSON]) {
    if (!envVar) continue;
    try {
      const parsed = JSON.parse(envVar);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const raw = typeof item === 'string' ? item : item?.rut;
          if (raw && typeof raw === 'string') {
            const norm = formatRut(raw.trim()) || raw.trim();
            if (norm) ruts.add(norm);
          }
        }
      }
    } catch {}
  }

  return Array.from(ruts);
}

function sanitizar<T extends Record<string, any>>(u: T): Omit<T, 'passwordHash' | 'pinHash'> {
  const { passwordHash, pinHash, ...resto } = u as any;
  return resto;
}

export class CrearUsuarioDto {
  @IsString()
  @IsNotEmpty()
  rut!: string;

  @IsString()
  @IsNotEmpty()
  nombre!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @IsOptional()
  cargo?: string;

  @IsString()
  @IsOptional()
  unidad?: string;

  @IsString()
  @IsOptional()
  rol?: 'ADMIN' | 'SUPERVISOR' | 'FUNCIONARIO' | 'MINISTRO_DE_FE';

  @IsString()
  @IsOptional()
  condicionContractual?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  pin?: string;
}

export class CambiarEstadoUsuarioDto {
  @IsString()
  @IsNotEmpty()
  estado!: 'ACTIVO' | 'EN_LICENCIA' | 'SUSPENDIDO' | 'DESVINCULADO';

  @IsString()
  @IsOptional()
  motivo?: string;

  @IsString()
  @IsOptional()
  ejecutadoPor?: string;
}

export class GenerarCredencialesAdminDto {
  @IsString()
  @IsNotEmpty()
  rut!: string;

  @IsString()
  @IsNotEmpty()
  nombre!: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  pinInicial?: string;
}

@Injectable()
export class UsuariosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsuariosService.name);
  private cronVencimientosTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    setTimeout(() => {
      this.ejecutarBarridoAutomaticoVencimientos().catch(() => {});
    }, 10000);

    this.cronVencimientosTimer = setInterval(() => {
      this.ejecutarBarridoAutomaticoVencimientos().catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cronVencimientosTimer) {
      clearInterval(this.cronVencimientosTimer);
      this.cronVencimientosTimer = null;
    }
  }

  async listarUsuarios(filtros?: {
    q?: string;
    rut?: string;
    nombre?: string;
    cargo?: string;
    unidad?: string;
    limit?: number;
  }) {
    try {
      const where: any = {};

      if (filtros?.q && filtros.q.trim()) {
        const queryTerm = filtros.q.trim();
        const rutVariants = getRutVariants(queryTerm);
        where.OR = [
          ...rutVariants.map((v) => ({ rut: { contains: v, mode: 'insensitive' } })),
          { nombre: { contains: queryTerm, mode: 'insensitive' } },
          { cargo: { contains: queryTerm, mode: 'insensitive' } },
          { email: { contains: queryTerm, mode: 'insensitive' } },
          { unidad: { contains: queryTerm, mode: 'insensitive' } },
        ];
      } else {
        if (filtros?.rut && filtros.rut.trim()) {
          const rutVariants = getRutVariants(filtros.rut.trim());
          if (rutVariants.length > 1) {
            where.OR = rutVariants.map((v) => ({ rut: { contains: v, mode: 'insensitive' } }));
          } else {
            where.rut = { contains: filtros.rut.trim(), mode: 'insensitive' };
          }
        }
        if (filtros?.nombre && filtros.nombre.trim()) {
          where.nombre = { contains: filtros.nombre.trim(), mode: 'insensitive' };
        }
        if (filtros?.cargo && filtros.cargo.trim()) {
          where.cargo = { contains: filtros.cargo.trim(), mode: 'insensitive' };
        }
        if (filtros?.unidad && filtros.unidad.trim()) {
          where.unidad = { contains: filtros.unidad.trim(), mode: 'insensitive' };
        }
      }

      const usuarios = await this.prisma.usuario.findMany({
        where,
        include: {
          certificados: {
            include: {
              tokenHardware: true,
            },
          },
        },
        orderBy: { nombre: 'asc' },
        ...(filtros?.limit ? { take: Number(filtros.limit) } : {}),
      });
      return usuarios.map((u) => sanitizar(u));
    } catch (err) {
      this.logger.error(`Error al listar usuarios: ${(err as Error).message}`);
      return [];
    }
  }

  async crearUsuario(dto: CrearUsuarioDto, ejecutor?: { sub?: string; email?: string }) {
    if (!dto.rut || !dto.nombre || !dto.email) {
      throw new BadRequestException('RUT, Nombre y Correo Electrónico son obligatorios.');
    }
    const rol = dto.rol || 'FUNCIONARIO';
    if (!ROLES_VALIDOS.includes(rol)) {
      throw new BadRequestException(`Rol inválido. Valores: ${ROLES_VALIDOS.join(', ')}`);
    }
    const rut = formatRut(dto.rut.trim()) || dto.rut.trim();
    const existente = await this.prisma.usuario.findFirst({
      where: { OR: [{ rut }, { rut: dto.rut.trim() }, { email: dto.email.trim().toLowerCase() }] },
    });
    if (existente) throw new ConflictException('Ya existe un usuario con ese RUT o correo.');

    let passwordTemporal: string | undefined;
    if (dto.password) {
      const err = validarFortalezaPassword(dto.password);
      if (err) throw new BadRequestException(err);
    } else {
      passwordTemporal = generarPasswordTemporal();
    }
    const passwordFinal = dto.password || passwordTemporal!;

    let pinTemporal: string | undefined;
    if (dto.pin && !/^\d{4,8}$/.test(dto.pin)) {
      throw new BadRequestException('El PIN debe ser numérico de 4 a 8 dígitos.');
    }
    if (!dto.pin) pinTemporal = generarPin();
    const pinFinal = dto.pin || pinTemporal!;

    const orgDefault = process.env.DEFAULT_ORG_NAME || 'Ilustre Municipalidad de Coquimbo';
    const nuevo = await this.prisma.usuario.create({
      data: {
        rut,
        nombre: dto.nombre.trim(),
        email: dto.email.trim().toLowerCase(),
        cargo: (dto.cargo || 'Funcionario').trim(),
        unidad: (dto.unidad || orgDefault).trim(),
        rol,
        condicionContractual: dto.condicionContractual || 'CONTRATA',
        passwordHash: hashSecret(passwordFinal),
        pinHash: hashSecret(pinFinal),
        debeCambiarPassword: true,
        estado: 'ACTIVO',
      },
    });

    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'usuarios',
          registroId: nuevo.rut,
          accion: rol === 'ADMIN' ? 'ALTA_ADMINISTRADOR' : 'ALTA_FUNCIONARIO',
          usuarioId: ejecutor?.sub || nuevo.id,
          usuarioEmail: ejecutor?.email || nuevo.email,
          diffJsonb: {
            nombre: nuevo.nombre,
            rol: nuevo.rol,
            unidad: nuevo.unidad,
            condicionContractual: nuevo.condicionContractual,
          },
        },
      })
      .catch(() => {});

    return {
      ...sanitizar(nuevo),
      ...(passwordTemporal ? { passwordTemporal } : {}),
      ...(pinTemporal ? { pinTemporal } : {}),
    };
  }

  async cambiarRol(idOrRut: string, rolNuevo: string, ejecutor: { sub: string; email: string }) {
    if (!ROLES_VALIDOS.includes(rolNuevo)) {
      throw new BadRequestException(`Rol inválido. Valores: ${ROLES_VALIDOS.join(', ')}`);
    }
    const u = await this.prisma.usuario.findFirst({ where: { OR: [{ id: idOrRut }, { rut: idOrRut }] } });
    if (!u) throw new NotFoundException(`Funcionario ${idOrRut} no encontrado`);

    if (u.rol === 'ADMIN' && rolNuevo !== 'ADMIN') {
      if (u.id === ejecutor.sub) {
        throw new BadRequestException('No puede quitarse a sí mismo el rol de administrador.');
      }
      const admins = await this.prisma.usuario.count({ where: { rol: 'ADMIN', estado: 'ACTIVO' } });
      if (admins <= 1) {
        throw new BadRequestException('Debe existir al menos un administrador activo.');
      }
    }

    const actualizado = await this.prisma.usuario.update({ where: { id: u.id }, data: { rol: rolNuevo as any } });
    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'usuarios',
          registroId: u.rut,
          accion: 'CAMBIO_ROL',
          usuarioId: ejecutor.sub,
          usuarioEmail: ejecutor.email,
          diffJsonb: { rolAnterior: u.rol, rolNuevo },
        },
      })
      .catch(() => {});
    return sanitizar(actualizado);
  }

  async resetPassword(idOrRut: string, ejecutor: { sub: string; email: string }) {
    const u = await this.prisma.usuario.findFirst({ where: { OR: [{ id: idOrRut }, { rut: idOrRut }] } });
    if (!u) throw new NotFoundException(`Funcionario ${idOrRut} no encontrado`);
    const passwordTemporal = generarPasswordTemporal();
    await this.prisma.usuario.update({
      where: { id: u.id },
      data: { passwordHash: hashSecret(passwordTemporal), debeCambiarPassword: true },
    });
    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'usuarios',
          registroId: u.rut,
          accion: 'RESET_PASSWORD_ADMIN',
          usuarioId: ejecutor.sub,
          usuarioEmail: ejecutor.email,
          diffJsonb: { rut: u.rut },
        },
      })
      .catch(() => {});
    return {
      rut: u.rut,
      passwordTemporal,
      mensaje: 'Entregue esta contraseña al funcionario; deberá cambiarla al ingresar. Se muestra una sola vez.',
    };
  }

  async cambiarEstadoUsuario(idOrRut: string, dto: CambiarEstadoUsuarioDto, ejecutor?: { sub: string; email: string }) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { OR: [{ id: idOrRut }, { rut: idOrRut }] },
      include: { certificados: true },
    });
    if (!usuario) {
      throw new NotFoundException(`Funcionario ${idOrRut} no encontrado`);
    }

    if (usuario.rol === 'ADMIN' && dto.estado !== 'ACTIVO') {
      if (ejecutor && usuario.id === ejecutor.sub) {
        throw new BadRequestException('No puede cambiar su propio estado de administrador.');
      }
      const admins = await this.prisma.usuario.count({ where: { rol: 'ADMIN', estado: 'ACTIVO' } });
      if (admins <= 1) {
        throw new BadRequestException('Debe existir al menos un administrador activo.');
      }
    }

    const estadoAnterior = usuario.estado;
    const esDesvinculacion = dto.estado === 'DESVINCULADO' || dto.estado === 'SUSPENDIDO';

    const actualizado = await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        estado: dto.estado,
        pinBloqueado: esDesvinculacion ? true : usuario.pinBloqueado,
      },
    });

    const certificadosRevocados: string[] = [];
    if (esDesvinculacion) {
      for (const cert of usuario.certificados) {
        if (cert.estado !== 'REVOCADO') {
          await this.prisma.certificado.update({
            where: { id: cert.id },
            data: { estado: 'REVOCADO' },
          });
          certificadosRevocados.push(cert.id);
        }
        if (cert.tokenHardwareId && dto.estado === 'DESVINCULADO') {
          await this.prisma.tokenHardware
            .update({
              where: { id: cert.tokenHardwareId },
              data: { estadoPatrimonial: 'EN_REVISION' },
            })
            .catch(() => {});
        }
      }
    }

    await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'usuarios',
        registroId: usuario.rut,
        accion: dto.estado === 'DESVINCULADO' ? 'DESVINCULACION_RRHH' : 'CAMBIO_ESTADO_USUARIO',
        usuarioId: ejecutor?.sub || usuario.id,
        usuarioEmail: ejecutor?.email || dto.ejecutadoPor || 'sistema',
        diffJsonb: {
          funcionario: usuario.nombre,
          rut: usuario.rut,
          estadoAnterior,
          estadoNuevo: dto.estado,
          motivo: dto.motivo || 'Actualización administrativa de ciclo de vida',
          certificadosRevocados,
          protocoloAnci48h: esDesvinculacion,
        },
      },
    });

    return {
      status: 'success',
      usuario: sanitizar(actualizado),
      certificadosRevocados,
      mensaje: esDesvinculacion
        ? `Protocolo ANCI/RRHH (<48h) ejecutado: Cuenta ${dto.estado} y ${certificadosRevocados.length} certificado(s) revocado(s).`
        : `Estado de ${usuario.nombre} actualizado a ${dto.estado}.`,
    };
  }

  async obtenerAlertasVencimiento() {
    const ahora = new Date();
    const en60Dias = new Date(ahora.getTime() + 60 * 24 * 60 * 60 * 1000);

    try {
      const certs = await this.prisma.certificado.findMany({
        where: {
          validoHasta: { lte: en60Dias, gte: ahora },
          estado: { in: ['VIGENTE', 'POR_VENCER'] },
        },
        include: {
          usuario: true,
          tokenHardware: true,
        },
        orderBy: { validoHasta: 'asc' },
      });

      return certs.map((c) => {
        const diasRestantes = Math.max(
          1,
          Math.ceil((c.validoHasta.getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24)),
        );
        const severidad = diasRestantes <= 15 ? 'ALTA' : diasRestantes <= 30 ? 'MEDIA' : 'BAJA';
        return {
          id: c.id,
          numeroSerie: c.numeroSerie,
          tipo: c.tipo === 'FIRMAGOB' ? 'FIRMAGOB (Token Criptográfico)' : 'FEA ESIGN (Cloudsigner HSM)',
          custodia: c.custodia,
          hardwareModelo: c.tokenHardware
            ? `${c.tokenHardware.marca} ${c.tokenHardware.modelo}`
            : 'Token Criptográfico',
          diasRestantes,
          severidad,
          fechaExpiracion: c.validoHasta.toISOString().split('T')[0],
          usuario: {
            nombre: c.usuario.nombre,
            unidad: c.usuario.unidad,
            email: c.usuario.email,
            rut: c.usuario.rut,
          },
        };
      });
    } catch (err) {
      this.logger.error(`Error al obtener alertas de vencimiento: ${(err as Error).message}`);
      return [];
    }
  }

  async despacharNotificacionVencimiento(payload: {
    certificadoId?: string;
    email?: string;
    nombre?: string;
    rut?: string;
    fechaExpiracion?: string;
    diasRestantes?: number;
    serialNumber?: string;
    masivo?: boolean;
    soloPreview?: boolean;
  }) {
    const emailDestino = payload.email?.trim() || undefined;
    let nombreTitular = payload.nombre?.trim() || '';
    let rutTitular = payload.rut?.trim() || '';
    let fechaVencimiento = payload.fechaExpiracion?.trim() || '';
    let diasRestantes = payload.diasRestantes;

    if ((!nombreTitular || !fechaVencimiento || !emailDestino) && payload.certificadoId) {
      try {
        const cert = await this.prisma.certificado.findUnique({
          where: { id: payload.certificadoId },
          include: { usuario: true, tokenHardware: true },
        });
        if (cert) {
          nombreTitular = nombreTitular || cert.usuario?.nombre || 'Funcionario(a)';
          rutTitular = rutTitular || cert.usuario?.rut || '-';
          fechaVencimiento = fechaVencimiento || cert.validoHasta.toISOString().slice(0, 10);
          if (diasRestantes === undefined) {
            diasRestantes = Math.ceil((cert.validoHasta.getTime() - Date.now()) / 86400000);
          }
        }
      } catch {}
    }

    const plantilla = generarPlantillaCorreoCaducidad({
      nombre: nombreTitular || 'Funcionario(a) Municipal',
      rut: rutTitular || '-',
      fechaVencimiento: fechaVencimiento || '-',
      diasRestantes: diasRestantes ?? 0,
      serialNumber: payload.serialNumber,
    });

    let enviadoSmtp = false;
    let motivoSmtp = payload.soloPreview
      ? 'Vista previa lista para enviar por SMTP'
      : 'Plantilla generada (SMTP no configurado en .env)';

    const smtpHost = process.env.SMTP_HOST || '';
    const smtpUser = process.env.SMTP_USER || '';
    const smtpPass = process.env.SMTP_PASS || '';
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;
    const officeName = process.env.MAIL_OFFICE_NAME || 'Oficina de Transformación Digital';
    const deptName = process.env.MAIL_DEPT_NAME || 'Departamento de Gestión de Sistemas y TICS';
    const smtpFrom =
      process.env.SMTP_FROM || (smtpUser ? `"${officeName} - ${deptName}" <${smtpUser}>` : '');

    const smtpPassPendiente =
      !smtpPass ||
      smtpPass.includes('REEMPLAZAR_CON_APP_PASSWORD') ||
      smtpPass.includes('CHANGE_ME');

    if (!payload.soloPreview) {
      if (smtpHost && smtpUser && !smtpPassPendiente && emailDestino) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            auth: { user: smtpUser, pass: smtpPass },
          });

          const escudoPath = path.resolve(process.cwd(), 'assets/escudo-municoquimbo.png');
          const attachments = fs.existsSync(escudoPath)
            ? [
                {
                  filename: 'escudo-municoquimbo.png',
                  path: escudoPath,
                  cid: 'escudo_municoquimbo',
                },
              ]
            : [];

          await transporter.sendMail({
            from: smtpFrom || smtpUser,
            to: emailDestino,
            subject: plantilla.subject,
            text: plantilla.text,
            html: plantilla.html,
            attachments,
          });

          enviadoSmtp = true;
          motivoSmtp = `Enviado vía SMTP (${smtpUser}) a ${emailDestino}`;
          this.logger.log(`[SMTP] Aviso de caducidad enviado desde ${smtpUser} a ${emailDestino}`);
        } catch (smtpErr) {
          enviadoSmtp = false;
          motivoSmtp = `Error SMTP: ${(smtpErr as Error).message}`;
          this.logger.warn(`[SMTP] Error enviando a ${emailDestino}: ${(smtpErr as Error).message}`);
        }
      } else if (smtpPassPendiente && smtpUser) {
        motivoSmtp = `Falta configurar SMTP_PASS para ${smtpUser}`;
      }

      try {
        await this.prisma.historialCambio.create({
          data: {
            tablaAfectada: 'certificados',
            registroId: payload.certificadoId || 'MASIVO_CRON_60_30_15',
            accion: 'NOTIFICACION_VENCIMIENTO',
            usuarioEmail: emailDestino || 'cron-alertas@municoquimbo.cl',
            diffJsonb: {
              certificadoId: payload.certificadoId || 'TODOS_EN_UMBRAL',
              destinatario: emailDestino || 'TODOS_LOS_FUNCIONARIOS_POR_VENCER',
              remitente: smtpUser,
              titular: nombreTitular || undefined,
              enviadoSmtp,
              motivoSmtp,
              timestamp: new Date().toISOString(),
            },
          },
        });
      } catch {}
    }

    return {
      status: payload.soloPreview ? 'preview' : 'dispatched',
      enviadoSmtp,
      motivoSmtp,
      remitenteSmtp: smtpUser,
      certificadoId: payload.certificadoId || 'ALL',
      emailDestino: emailDestino || 'multiple',
      asunto: plantilla.subject,
      cuerpoCorreo: plantilla.text,
      htmlCorreo: plantilla.html,
      timestamp: new Date().toISOString(),
    };
  }

  async ejecutarBarridoAutomaticoVencimientos() {
    try {
      const ahora = new Date();
      const alertas = await this.obtenerAlertasVencimiento();

      await this.prisma.certificado.updateMany({
        where: {
          validoHasta: { lt: ahora },
          estado: { in: ['VIGENTE', 'POR_VENCER'] },
        },
        data: { estado: 'VENCIDO' },
      });

      if (alertas.length === 0) return { procesados: 0 };

      let criticos15 = 0;
      let medios30 = 0;
      let preventivos60 = 0;

      for (const a of alertas) {
        if (a.diasRestantes <= 15) criticos15++;
        else if (a.diasRestantes <= 30) medios30++;
        else preventivos60++;

        if (a.diasRestantes <= 30) {
          await this.prisma.certificado
            .update({
              where: { id: a.id },
              data: { estado: 'POR_VENCER' },
            })
            .catch(() => {});
        }
      }

      await this.prisma.historialCambio.create({
        data: {
          tablaAfectada: 'certificados',
          registroId: 'CRON_AUTOMATICO_60_30_15',
          accion: 'BARRIDO_AUTOMATICO_VENCIMIENTOS',
          usuarioEmail: 'scheduler-automatico@municoquimbo.cl',
          diffJsonb: {
            totalAlertasDetectadas: alertas.length,
            umbral15DiasCritico: criticos15,
            umbral30DiasMedio: medios30,
            umbral60DiasPreventivo: preventivos60,
            timestamp: ahora.toISOString(),
          },
        },
      });

      this.logger.log(
        `[Scheduler Vencimientos] Barrido completado: ${alertas.length} certificado(s) en ventana 60/30/15 días.`,
      );
      return {
        procesados: alertas.length,
        criticos15,
        medios30,
        preventivos60,
      };
    } catch (err) {
      this.logger.warn(`Aviso en barrido automático de vencimientos: ${(err as Error).message}`);
      return { procesados: 0 };
    }
  }

  async listarAdministradores() {
    const protegidos = getSuperadminsProtegidos();
    const admins = await this.prisma.usuario.findMany({
      where: { rol: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
    });
    return admins.map((u) => ({
      ...sanitizar(u),
      esFijo: protegidos.includes(u.rut),
    }));
  }

  async generarCredencialesAdmin(
    dto: { rut: string; nombre: string; email?: string; pinInicial?: string },
    ejecutor?: { sub?: string; email?: string },
  ) {
    const rutRaw = dto.rut?.trim() || '';
    const rut = formatRut(rutRaw) || rutRaw;
    const nombre = dto.nombre?.trim() || '';
    if (!rut || !nombre) {
      throw new BadRequestException('RUT y nombre son obligatorios.');
    }

    const pinRaw = dto.pinInicial?.trim() || '';
    if (pinRaw && pinRaw.length !== 6) {
      throw new BadRequestException('El PIN inicial debe tener exactamente 6 caracteres.');
    }
    const pinFinal = pinRaw || String(Math.floor(100000 + Math.random() * 900000));

    const emailInput = dto.email?.trim().toLowerCase() || '';
    const email = emailInput || `admin.${rut.replace(/[^0-9kK]/g, '').toLowerCase()}@municoquimbo.cl`;

    const existente = await this.prisma.usuario.findFirst({
      where: { OR: [{ rut }, { email }] },
    });

    if (existente && existente.rol === 'ADMIN' && existente.estado === 'ACTIVO') {
      throw new ConflictException(`Ya existe un administrador activo con ese RUT o correo (${existente.rut}).`);
    }

    const orgDefault = process.env.DEFAULT_ORG_NAME || 'Ilustre Municipalidad de Coquimbo';
    const u = existente
      ? await this.prisma.usuario.update({
          where: { id: existente.id },
          data: {
            rol: 'ADMIN',
            estado: 'ACTIVO',
            nombre,
            passwordHash: hashSecret(pinFinal),
            pinHash: hashSecret(pinFinal),
            pinBloqueado: false,
            debeCambiarPassword: true,
          },
        })
      : await this.prisma.usuario.create({
          data: {
            rut,
            nombre,
            email,
            cargo: 'Administrador Delegado',
            unidad: orgDefault,
            rol: 'ADMIN',
            estado: 'ACTIVO',
            passwordHash: hashSecret(pinFinal),
            pinHash: hashSecret(pinFinal),
            debeCambiarPassword: true,
          },
        });

    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'usuarios',
          registroId: u.rut,
          accion: 'GENERAR_CREDENCIALES_ADMIN',
          usuarioId: ejecutor?.sub || u.id,
          usuarioEmail: ejecutor?.email || u.email,
          diffJsonb: {
            rut: u.rut,
            nombre: u.nombre,
            email: u.email,
            promovidoDesdeExistente: !!existente,
            rolAnterior: existente?.rol || null,
            estadoAnterior: existente?.estado || null,
          },
        },
      })
      .catch(() => {});

    const protegidos = getSuperadminsProtegidos();
    return {
      usuario: {
        ...sanitizar(u),
        esFijo: protegidos.includes(u.rut),
      },
      credenciales: {
        rut: u.rut,
        pinInicial: pinFinal,
      },
    };
  }

  async revocarAdministrador(idOrRut: string, ejecutor: { sub: string; email: string }) {
    const rutFormateado = formatRut(idOrRut);
    const u = await this.prisma.usuario.findFirst({
      where: {
        OR: [
          { id: idOrRut },
          { rut: idOrRut },
          ...(rutFormateado ? [{ rut: rutFormateado }] : []),
        ],
      },
    });
    if (!u) {
      throw new NotFoundException(`Administrador ${idOrRut} no encontrado.`);
    }

    if (u.id === ejecutor.sub) {
      throw new BadRequestException('No puede revocar sus propias facultades de administrador.');
    }
    const adminPrincipal = getAdminPrincipalRut();
    if (adminPrincipal && u.rut === adminPrincipal) {
      throw new BadRequestException(`No es posible revocar al administrador titular principal (${adminPrincipal}).`);
    }
    const adminsActivos = await this.prisma.usuario.count({ where: { rol: 'ADMIN', estado: 'ACTIVO' } });
    if (adminsActivos <= 1) {
      throw new BadRequestException('Debe existir al menos un administrador activo.');
    }

    await this.prisma.usuario.update({
      where: { id: u.id },
      data: {
        rol: 'FUNCIONARIO',
        estado: 'SUSPENDIDO',
        pinBloqueado: true,
        debeCambiarPassword: true,
        passwordHash: hashSecret(generarPasswordTemporal()),
      },
    });

    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'usuarios',
          registroId: u.rut,
          accion: 'REVOCAR_ADMIN',
          usuarioId: ejecutor.sub,
          usuarioEmail: ejecutor.email,
          diffJsonb: {
            rut: u.rut,
            nombre: u.nombre,
            rolAnterior: u.rol,
            estadoAnterior: u.estado,
            rolNuevo: 'FUNCIONARIO',
            estadoNuevo: 'SUSPENDIDO',
          },
        },
      })
      .catch(() => {});

    return {
      status: 'success',
      rut: u.rut,
      nombre: u.nombre,
      mensaje: 'Facultades de administrador revocadas inmediatamente.',
    };
  }
}

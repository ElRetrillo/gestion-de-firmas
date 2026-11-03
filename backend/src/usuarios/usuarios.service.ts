import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashSecret, generarPasswordTemporal, generarPin, validarFortalezaPassword } from '../common/crypto.util';
import { formatRut, getRutVariants } from '../common/rut.util';

const ROLES_VALIDOS = ['ADMIN', 'SUPERVISOR', 'FUNCIONARIO', 'MINISTRO_DE_FE', 'PENDIENTE'];

function sanitizar<T extends Record<string, any>>(u: T): Omit<T, 'passwordHash' | 'pinHash'> {
  const { passwordHash, pinHash, ...resto } = u as any;
  return resto;
}

import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

export class SolicitarModificacionDatosDto {
  @IsString()
  @IsOptional()
  rut?: string;

  @IsString()
  @IsOptional()
  nuevoCargo?: string;

  @IsString()
  @IsOptional()
  nuevaUnidad?: string;

  @IsString()
  @IsOptional()
  nuevaCondicionContractual?: string;

  @IsEmail()
  @IsOptional()
  nuevoEmail?: string;

  @IsString()
  @IsNotEmpty()
  justificacion!: string;
}

export class ResolverModificacionDatosDto {
  @IsString()
  @IsNotEmpty()
  decision!: 'APROBADA' | 'RECHAZADA';

  @IsString()
  @IsOptional()
  observacion?: string;
}

@Injectable()
export class UsuariosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsuariosService.name);
  private cronVencimientosTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Ejecución inicial diferida (10s tras arranque) y programación automática cada 24 horas (Módulo 2: Alertas 60, 30 y 15 días)
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
          actasCustodia: true,
        },
        orderBy: { nombre: 'asc' },
        ...(filtros?.limit ? { take: Number(filtros.limit) } : {}),
      });
      return usuarios.map((u) => sanitizar(u));
    } catch (err) {
      this.logger.error(`Error al listar usuarios en base de datos: ${(err as Error).message}`);
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

    const nuevo = await this.prisma.usuario.create({
      data: {
        rut,
        nombre: dto.nombre.trim(),
        email: dto.email.trim().toLowerCase(),
        cargo: (dto.cargo || 'Funcionario').trim(),
        unidad: (dto.unidad || 'Municipalidad de Coquimbo').trim(),
        rol,
        condicionContractual: dto.condicionContractual || 'CONTRATA',
        passwordHash: hashSecret(passwordFinal),
        pinHash: hashSecret(pinFinal),
        debeCambiarPassword: true,
        estado: 'ACTIVO',
      },
    });

    await this.prisma.historialCambio.create({
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
    }).catch(() => {});

    return {
      ...sanitizar(nuevo),
      // Credenciales temporales: se muestran UNA sola vez.
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
    await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'usuarios',
        registroId: u.rut,
        accion: 'CAMBIO_ROL',
        usuarioId: ejecutor.sub,
        usuarioEmail: ejecutor.email,
        diffJsonb: { rolAnterior: u.rol, rolNuevo },
      },
    }).catch(() => {});
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
    await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'usuarios',
        registroId: u.rut,
        accion: 'RESET_PASSWORD_ADMIN',
        usuarioId: ejecutor.sub,
        usuarioEmail: ejecutor.email,
        diffJsonb: { rut: u.rut },
      },
    }).catch(() => {});
    return { rut: u.rut, passwordTemporal, mensaje: 'Entregue esta contraseña al funcionario; deberá cambiarla al ingresar. Se muestra una sola vez.' };
  }

  /**
   * Módulo 1 (Sección 3.1): Ciclo de vida del funcionario y protocolo de bloqueo <48h RRHH
   */
  async cambiarEstadoUsuario(idOrRut: string, dto: CambiarEstadoUsuarioDto, ejecutor?: { sub: string; email: string }) {
    {
      const usuario = await this.prisma.usuario.findFirst({
        where: {
          OR: [{ id: idOrRut }, { rut: idOrRut }],
        },
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

      // Si es desvinculación o suspensión, revocar inmediatamente todos sus certificados (Ley 21.663 <48h)
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
            await this.prisma.tokenHardware.update({
              where: { id: cert.tokenHardwareId },
              data: { estadoPatrimonial: 'EN_REVISION' },
            }).catch(() => {});
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
  }

  async obtenerAlertasVencimiento() {
    const ahora = new Date();
    const en60Dias = new Date(ahora.getTime() + 60 * 24 * 60 * 60 * 1000);

    try {
      const certs = await this.prisma.certificado.findMany({
        where: {
          validoHasta: {
            lte: en60Dias,
            gte: ahora,
          },
          estado: {
            in: ['VIGENTE', 'POR_VENCER'],
          },
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
            : 'Thales Luna HSM Cloud',
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

  async despacharNotificacionVencimiento(certificadoId?: string, emailDestino?: string) {
    try {
      await this.prisma.historialCambio.create({
        data: {
          tablaAfectada: 'certificados',
          registroId: certificadoId || 'MASIVO_CRON_60_30_15',
          accion: 'NOTIFICACION_VENCIMIENTO',
          usuarioEmail: emailDestino || 'cron-alertas@municoquimbo.cl',
          diffJsonb: {
            certificadoId: certificadoId || 'TODOS_EN_UMBRAL',
            destinatario: emailDestino || 'TODOS_LOS_FUNCIONARIOS_POR_VENCER',
            escalasMonitoreadas: ['15_DIAS_CRITICO', '30_DIAS_MEDIA', '60_DIAS_PREVENTIVO'],
            timestamp: new Date().toISOString(),
          },
        },
      });
    } catch {
      // Ignorar si BD no disponible
    }

    return {
      status: 'dispatched',
      certificadoId: certificadoId || 'ALL',
      emailDestino: emailDestino || 'multiple',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Módulo 2: Barrido automático programado de vencimientos a 60, 30 y 15 días.
   * Actualiza certificados próximos a vencer y registra alertas preventivas en el Audit Trail.
   */
  async ejecutarBarridoAutomaticoVencimientos() {
    try {
      const ahora = new Date();
      const alertas = await this.obtenerAlertasVencimiento();

      // Marcar como VENCIDO aquellos cuya fecha ya expiró
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
        `[Scheduler Vencimientos] Barrido automático completado: ${alertas.length} certificado(s) en ventana de 60/30/15 días.`,
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

  /**
   * Módulo 5: Flujo formal de solicitudes de actualización de perfiles, cargos y traslados internos.
   */
  async solicitarModificacionDatos(
    dto: SolicitarModificacionDatosDto,
    solicitanteContext?: { sub?: string; rut?: string; email?: string },
  ) {
    const targetRut = dto.rut ? formatRut(dto.rut) : solicitanteContext?.rut;
    const usuario = await this.prisma.usuario.findFirst({
      where: targetRut
        ? { OR: [{ rut: targetRut }, { id: solicitanteContext?.sub || '' }] }
        : { id: solicitanteContext?.sub || '' },
    });

    if (!usuario) {
      throw new NotFoundException('No se encontró el funcionario para registrar la solicitud de modificación.');
    }

    const folio = `MOD-DATOS-2026-${Math.floor(1000 + Math.random() * 9000)}`;
    const registro = await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'usuarios',
        registroId: folio,
        accion: 'SOLICITUD_MODIFICACION_DATOS',
        usuarioId: usuario.id,
        usuarioEmail: usuario.email,
        diffJsonb: {
          folio,
          estadoSolicitud: 'PENDIENTE',
          usuarioId: usuario.id,
          rut: usuario.rut,
          nombre: usuario.nombre,
          datosActuales: {
            cargo: usuario.cargo,
            unidad: usuario.unidad,
            condicionContractual: usuario.condicionContractual,
            email: usuario.email,
          },
          cambiosSolicitados: {
            nuevoCargo: dto.nuevoCargo || usuario.cargo,
            nuevaUnidad: dto.nuevaUnidad || usuario.unidad,
            nuevaCondicionContractual: dto.nuevaCondicionContractual || usuario.condicionContractual,
            nuevoEmail: dto.nuevoEmail || usuario.email,
          },
          justificacion: dto.justificacion,
          fechaSolicitud: new Date().toISOString(),
        },
      },
    });

    return {
      status: 'registered',
      folio,
      id: registro.id,
      estado: 'PENDIENTE',
      mensaje: `Solicitud formal de modificación ${folio} registrada y enviada a visación de TICs/RRHH.`,
    };
  }

  async listarSolicitudesModificacion() {
    const registros = await this.prisma.historialCambio.findMany({
      where: {
        accion: {
          in: [
            'SOLICITUD_MODIFICACION_DATOS',
            'SOLICITUD_MODIFICACION_APROBADA',
            'SOLICITUD_MODIFICACION_RECHAZADA',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return registros.map((r) => {
      const meta = (r.diffJsonb as Record<string, any>) || {};
      return {
        id: r.id,
        folio: meta.folio || r.registroId,
        estadoSolicitud: meta.estadoSolicitud || 'PENDIENTE',
        rut: meta.rut || '',
        nombre: meta.nombre || r.usuarioEmail,
        datosActuales: meta.datosActuales || {},
        cambiosSolicitados: meta.cambiosSolicitados || {},
        justificacion: meta.justificacion || '',
        observacionResolucion: meta.observacionResolucion || null,
        resueltoPor: meta.resueltoPor || null,
        createdAt: r.createdAt,
      };
    });
  }

  async resolverSolicitudModificacion(
    solicitudIdOrFolio: string,
    dto: ResolverModificacionDatosDto,
    ejecutor: { sub: string; email: string },
  ) {
    const registro = await this.prisma.historialCambio.findFirst({
      where: {
        OR: [{ id: solicitudIdOrFolio }, { registroId: solicitudIdOrFolio }],
      },
    });

    if (!registro) {
      throw new NotFoundException(`Solicitud de modificación ${solicitudIdOrFolio} no encontrada.`);
    }

    const meta = (registro.diffJsonb as Record<string, any>) || {};
    const cambios = meta.cambiosSolicitados || {};
    const usuarioId = meta.usuarioId || registro.usuarioId;

    if (dto.decision === 'APROBADA' && usuarioId) {
      await this.prisma.usuario.update({
        where: { id: usuarioId },
        data: {
          ...(cambios.nuevoCargo ? { cargo: cambios.nuevoCargo } : {}),
          ...(cambios.nuevaUnidad ? { unidad: cambios.nuevaUnidad } : {}),
          ...(cambios.nuevaCondicionContractual
            ? { condicionContractual: cambios.nuevaCondicionContractual }
            : {}),
          ...(cambios.nuevoEmail ? { email: cambios.nuevoEmail.toLowerCase() } : {}),
        },
      });
    }

    const nuevaAccion =
      dto.decision === 'APROBADA'
        ? 'SOLICITUD_MODIFICACION_APROBADA'
        : 'SOLICITUD_MODIFICACION_RECHAZADA';

    const actualizado = await this.prisma.historialCambio.update({
      where: { id: registro.id },
      data: {
        accion: nuevaAccion,
        diffJsonb: {
          ...meta,
          estadoSolicitud: dto.decision,
          observacionResolucion: dto.observacion || null,
          resueltoPor: ejecutor.email,
          fechaResolucion: new Date().toISOString(),
        },
      },
    });

    return {
      status: 'resolved',
      id: actualizado.id,
      folio: meta.folio || actualizado.registroId,
      decision: dto.decision,
      resueltoPor: ejecutor.email,
    };
  }
}

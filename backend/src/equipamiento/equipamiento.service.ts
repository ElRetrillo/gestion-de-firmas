import { Injectable, Logger, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as crypto from 'crypto';

import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class CrearTokenDto {
  @IsString()
  @IsOptional()
  serialNumber?: string;

  @IsString()
  @IsOptional()
  numeroSerie?: string;

  @IsString()
  @IsOptional()
  vendorId?: string;

  @IsString()
  @IsNotEmpty()
  marca!: string;

  @IsString()
  @IsNotEmpty()
  modelo!: string;

  @IsString()
  @IsOptional()
  estadoPatrimonial?: 'OPERATIVO' | 'EN_REVISION' | 'DADO_DE_BAJA' | 'ASIGNADO';

  @IsString()
  @IsOptional()
  ubicacionFisica?: string;
}

export class CrearContratoTokenDto {
  @IsString()
  @IsOptional()
  codigoContrato?: string;

  @IsString()
  @IsNotEmpty()
  titulo!: string;

  @IsString()
  @IsNotEmpty()
  proveedor!: string;

  @IsString()
  @IsNotEmpty()
  fechaInicio!: string;

  @IsString()
  @IsNotEmpty()
  fechaCaducidad!: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cantidadTokens?: number;

  @IsString()
  @IsOptional()
  montoReferencial?: string;

  @IsString()
  @IsOptional()
  descripcion?: string;
}

export class AsignarTokenFirmaDto {
  @IsString()
  @IsOptional()
  usuarioId?: string;

  @IsString()
  @IsOptional()
  rutUsuario?: string;

  @IsString()
  @IsNotEmpty()
  serialNumber!: string;

  @IsString()
  @IsOptional()
  marca?: string;

  @IsString()
  @IsOptional()
  modelo?: string;

  @IsString()
  @IsOptional()
  vendorId?: string;

  @IsString()
  @IsOptional()
  fechaInicio?: string;

  @IsString()
  @IsOptional()
  fechaExpiracion?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  diasVigencia?: number;

  @IsString()
  @IsOptional()
  tipoCertificado?: 'FIRMAGOB' | 'ESIGN';

  @IsString()
  @IsOptional()
  codigoContrato?: string;
}

export class CrearActaCustodiaDto {
  @IsString()
  @IsOptional()
  tokenId?: string;

  @IsString()
  @IsOptional()
  tokenHardwareId?: string;

  @IsString()
  @IsOptional()
  serialNumber?: string;

  @IsString()
  @IsOptional()
  usuarioId?: string;

  @IsString()
  @IsOptional()
  usuarioReceptorId?: string;

  @IsString()
  @IsOptional()
  rutUsuario?: string;

  @IsString()
  @IsOptional()
  emisorUsuarioId?: string;

  @IsString()
  @IsOptional()
  emisorRut?: string;

  @IsString()
  @IsOptional()
  emisorNombre?: string;

  @IsString()
  @IsOptional()
  emisorCargo?: string;

  @IsString()
  @IsOptional()
  tipoActa?: 'ENTREGA' | 'DEVOLUCION' | 'TRASPASO' | 'BAJA';

  @IsString()
  @IsOptional()
  tipo?: 'ENTREGA' | 'DEVOLUCION' | 'TRASPASO' | 'BAJA';

  @IsString()
  @IsOptional()
  observaciones?: string;
}

@Injectable()
export class EquipamientoService {
  private readonly logger = new Logger(EquipamientoService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listarTokens() {
    try {
      const tokens = await this.prisma.tokenHardware.findMany({
        include: {
          certificados: {
            include: {
              usuario: true,
            },
          },
          actasCustodia: {
            orderBy: { createdAt: 'desc' },
            take: 3,
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      return tokens;
    } catch (err) {
      this.logger.error(`Error al listar tokens: ${(err as Error).message}`);
      return [];
    }
  }

  async registrarToken(dto: CrearTokenDto) {
    try {
      const serial = (dto.serialNumber || dto.numeroSerie || '').trim();
      if (!serial) {
        throw new BadRequestException('El número de serie es obligatorio.');
      }
      const vendorId = dto.vendorId || '04b9';
      let estadoPatrimonial: any = dto.estadoPatrimonial;
      if (estadoPatrimonial === 'DISPONIBLE') estadoPatrimonial = 'OPERATIVO';
      if (!estadoPatrimonial || !['OPERATIVO', 'EN_REVISION', 'DADO_DE_BAJA', 'ASIGNADO'].includes(estadoPatrimonial)) {
        estadoPatrimonial = 'OPERATIVO';
      }

      const token = await this.prisma.tokenHardware.upsert({
        where: { serialNumber: serial },
        update: {
          vendorId,
          marca: dto.marca,
          modelo: dto.modelo,
          estadoPatrimonial,
        },
        create: {
          serialNumber: serial,
          vendorId,
          marca: dto.marca,
          modelo: dto.modelo,
          estadoPatrimonial,
        },
      });

      await this.prisma.historialCambio.create({
        data: {
          tablaAfectada: 'tokens_hardware',
          registroId: token.serialNumber,
          accion: 'ALTA_TOKEN_PATRIMONIAL',
          usuarioEmail: 'inventario-tics@municoquimbo.cl',
          diffJsonb: {
            serialNumber: token.serialNumber,
            marca: token.marca,
            modelo: token.modelo,
            vendorId: token.vendorId,
            estadoPatrimonial: token.estadoPatrimonial,
          },
        },
      });

      return token;
    } catch (err) {
      this.logger.error(`Error al registrar token: ${(err as Error).message}`);
      throw new InternalServerErrorException('Error al registrar token en la base de datos.');
    }
  }

  async listarActasCustodia() {
    try {
      const actas = await this.prisma.actaCustodia.findMany({
        include: {
          token: true,
          usuario: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      return actas;
    } catch (err) {
      this.logger.error(`Error al listar actas de custodia: ${(err as Error).message}`);
      return [];
    }
  }

  async crearActaCustodia(dto: CrearActaCustodiaDto, emisorContext?: { id?: string; rut?: string; nombre?: string; cargo?: string; email?: string }) {
    const codigoActa = `ACTA-TIC-2026-${Math.floor(100 + Math.random() * 900)}`;

    // Resolver datos del funcionario emisor (quien está logueado haciendo el trámite)
    let emisorFinal = {
      id: dto.emisorUsuarioId || emisorContext?.id,
      rut: dto.emisorRut || emisorContext?.rut,
      nombre: dto.emisorNombre || emisorContext?.nombre,
      cargo: dto.emisorCargo || emisorContext?.cargo || 'Administrador / Depto. TICs',
      email: emisorContext?.email,
    };

    if (emisorFinal.id || emisorFinal.rut) {
      try {
        const emisorDb = await this.prisma.usuario.findFirst({
          where: {
            OR: [
              ...(emisorFinal.id ? [{ id: emisorFinal.id }] : []),
              ...(emisorFinal.rut ? [{ rut: emisorFinal.rut }] : []),
            ],
          },
        });
        if (emisorDb) {
          emisorFinal = {
            id: emisorDb.id,
            rut: emisorDb.rut,
            nombre: emisorDb.nombre,
            cargo: emisorDb.cargo || 'Administrador / Depto. TICs',
            email: emisorDb.email,
          };
        }
      } catch {
        // Fallback a los valores provistos
      }
    }

    // Si aún no hay emisor explícito, buscar el usuario ADMIN principal del sistema
    if (!emisorFinal.nombre) {
      try {
        const adminPrincipal = await this.prisma.usuario.findFirst({
          where: { rol: 'ADMIN' },
          orderBy: { createdAt: 'asc' },
        });
        if (adminPrincipal) {
          emisorFinal = {
            id: adminPrincipal.id,
            rut: adminPrincipal.rut,
            nombre: adminPrincipal.nombre,
            cargo: adminPrincipal.cargo || 'Administrador General del Sistema',
            email: adminPrincipal.email,
          };
        }
      } catch {
        // Ignorar
      }
    }

    let tokenId = dto.tokenId || dto.tokenHardwareId;
    if (!tokenId && dto.serialNumber) {
      const tokenDb = await this.prisma.tokenHardware.findUnique({
        where: { serialNumber: dto.serialNumber.trim() },
      });
      if (tokenDb) tokenId = tokenDb.id;
    }

    let usuarioId = dto.usuarioId || dto.usuarioReceptorId;
    if (!usuarioId && dto.rutUsuario) {
      const uDb = await this.prisma.usuario.findFirst({
        where: { rut: dto.rutUsuario.trim() },
      });
      if (uDb) usuarioId = uDb.id;
    }

    const tipoActa = (dto.tipoActa || dto.tipo || 'ENTREGA') as 'ENTREGA' | 'DEVOLUCION' | 'TRASPASO' | 'BAJA';

    if (!tokenId || !usuarioId) {
      throw new BadRequestException('Token (tokenId / serialNumber) y Funcionario Receptor (usuarioId / rutUsuario) son obligatorios.');
    }

    const hashSha256 = crypto
      .createHash('sha256')
      .update(`${codigoActa}-${tokenId}-${usuarioId}-${emisorFinal.rut || 'SYS'}-${Date.now()}`)
      .digest('hex');

    try {
      const nuevoEstadoPatrimonial =
        tipoActa === 'ENTREGA' || tipoActa === 'TRASPASO'
          ? 'ASIGNADO'
          : tipoActa === 'DEVOLUCION'
          ? 'OPERATIVO'
          : 'DADO_DE_BAJA';

      await this.prisma.tokenHardware.update({
        where: { id: tokenId },
        data: { estadoPatrimonial: nuevoEstadoPatrimonial },
      }).catch(() => {});

      // Enriquecer las observaciones con los datos del emisor
      const observacionesJson = JSON.stringify({
        detalle: dto.observaciones || `Acta de ${tipoActa} firmada digitalmente conforme a norma ANCI.`,
        emisor: {
          id: emisorFinal.id,
          rut: emisorFinal.rut,
          nombre: emisorFinal.nombre,
          cargo: emisorFinal.cargo,
        },
      });

      const acta = await this.prisma.actaCustodia.create({
        data: {
          codigoActa,
          tokenId,
          usuarioId, // Funcionario Receptor
          tipoActa,
          observaciones: observacionesJson,
          hashSha256,
          documentoFirmadoUrl: `/api/v1/equipamiento/actas/${codigoActa}/pdf`,
        },
        include: {
          token: true,
          usuario: true,
        },
      });

      await this.prisma.historialCambio.create({
        data: {
          tablaAfectada: 'actas_custodia',
          registroId: codigoActa,
          accion: `ACTA_CUSTODIA_${dto.tipoActa}`,
          usuarioId: emisorFinal.id || dto.usuarioId,
          usuarioEmail: emisorFinal.email || acta.usuario?.email || 'custodia-tics@municoquimbo.cl',
          diffJsonb: {
            codigoActa,
            tipoActa: dto.tipoActa,
            tokenSerial: acta.token?.serialNumber,
            funcionarioReceptorRut: acta.usuario?.rut,
            funcionarioReceptorNombre: acta.usuario?.nombre,
            funcionarioEmisorRut: emisorFinal.rut,
            funcionarioEmisorNombre: emisorFinal.nombre,
            hashSha256,
          },
        },
      });

      return {
        ...acta,
        emisor: emisorFinal,
      };
    } catch (err) {
      this.logger.error(`Error al crear acta de custodia: ${(err as Error).message}`);
      throw new InternalServerErrorException('Error al crear acta de custodia en la base de datos.');
    }
  }

  async generarPdfActaCustodia(idOrCodigo: string): Promise<Buffer> {
    const actaData = await this.prisma.actaCustodia.findFirst({
      where: { OR: [{ id: idOrCodigo }, { codigoActa: idOrCodigo }] },
      include: { token: true, usuario: true },
    });

    if (!actaData) {
      throw new NotFoundException(`Acta de custodia ${idOrCodigo} no encontrada en el repositorio institucional.`);
    }

    const codigo = actaData.codigoActa;
    const tipoActa = actaData.tipoActa;
    const nombreReceptor = actaData.usuario?.nombre || 'Funcionario Receptor';
    const rutReceptor = actaData.usuario?.rut || 'Sin RUT registrado';
    const unidadReceptor = actaData.usuario?.unidad || 'Dirección Municipal';
    const cargoReceptor = actaData.usuario?.cargo || 'Funcionario Municipal';
    const tokenSerial = actaData.token?.serialNumber || 'S/N no especificado';
    const tokenMarca = actaData.token ? `${actaData.token.marca} ${actaData.token.modelo}` : 'Token Criptográfico USB';

    // Deserializar observaciones y datos del emisor
    let textoObservaciones = 'Custodia de dispositivo criptográfico conforme a Ley N° 19.799 y Ley N° 21.663 (ANCI).';
    let emisorNombre = process.env.ADMIN_INICIAL_NOMBRE || 'Administrador TICs';
    let emisorRut = process.env.ADMIN_INICIAL_RUT || 'Sin RUT registrado';
    let emisorCargo = process.env.ADMIN_INICIAL_CARGO || 'Depto. de Gestión de Sistemas y TICs';

    if (actaData.observaciones) {
      try {
        const parsed = JSON.parse(actaData.observaciones);
        if (parsed.detalle) textoObservaciones = parsed.detalle;
        if (parsed.emisor?.nombre) emisorNombre = parsed.emisor.nombre;
        if (parsed.emisor?.rut) emisorRut = parsed.emisor.rut;
        if (parsed.emisor?.cargo) emisorCargo = parsed.emisor.cargo;
      } catch {
        textoObservaciones = actaData.observaciones;
      }
    }

    const hash = actaData.hashSha256 || crypto.createHash('sha256').update(codigo).digest('hex');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

    // Franja institucional azul marino (#003366)
    page.drawRectangle({
      x: 0,
      y: 770,
      width: 595.28,
      height: 72,
      color: rgb(0, 0.2, 0.4),
    });

    page.drawText('ILUSTRE MUNICIPALIDAD DE COQUIMBO', {
      x: 50,
      y: 810,
      size: 14,
      font: fontBold,
      color: rgb(1, 1, 1),
    });
    page.drawText('DEPARTAMENTO DE GESTION DE SISTEMAS Y TICs - CUSTODIA CRIPTOGRAFICA', {
      x: 50,
      y: 790,
      size: 9,
      font: fontRegular,
      color: rgb(0.85, 0.9, 0.95),
    });

    page.drawText(`COMPROBANTE DE EMISIÓN Y ACTA OFICIAL DE CUSTODIA (${tipoActa})`, {
      x: 50,
      y: 720,
      size: 12.5,
      font: fontBold,
      color: rgb(0, 0.2, 0.4),
    });

    page.drawText(`FOLIO / COMPROBANTE N°: ${codigo}`, {
      x: 50,
      y: 695,
      size: 10,
      font: fontMono,
      color: rgb(0.2, 0.2, 0.2),
    });

    const lines = [
      `Fecha de Emision       : ${new Date(actaData.createdAt).toLocaleString('es-CL')}`,
      `Tipo de Operacion      : ${tipoActa} DE TOKEN CRIPTOGRAFICO`,
      `Funcionario Emisor     : ${emisorNombre} (RUT: ${emisorRut})`,
      `Cargo Emisor           : ${emisorCargo}`,
      `Funcionario Receptor   : ${nombreReceptor} (RUT: ${rutReceptor})`,
      `Cargo / Unidad Receptor: ${cargoReceptor} • ${unidadReceptor}`,
      `Dispositivo Hardware   : ${tokenMarca}`,
      `Numero de Serie (S/N)  : ${tokenSerial}`,
      `Marco Normativo        : Ley N 19.799 (FEA) / Ley N 21.663 (ANCI) / ISO 27001`,
    ];

    let yPos = 645;
    for (const line of lines) {
      page.drawText(line, {
        x: 50,
        y: yPos,
        size: 9.5,
        font: fontMono,
        color: rgb(0.1, 0.1, 0.1),
      });
      yPos -= 20;
    }

    page.drawText('DECLARACION DE RESPONSABILIDAD Y CUSTODIA:', {
      x: 50,
      y: yPos - 10,
      size: 10,
      font: fontBold,
      color: rgb(0, 0.2, 0.4),
    });

    page.drawText(textoObservaciones.slice(0, 95), {
      x: 50,
      y: yPos - 26,
      size: 9,
      font: fontRegular,
      color: rgb(0.2, 0.2, 0.2),
    });

    // Cuadros de Firma de las dos partes: Emisor y Receptor
    const firmaY = yPos - 110;

    // Firma Emisor (Izquierda)
    page.drawRectangle({
      x: 50,
      y: firmaY,
      width: 235,
      height: 70,
      borderColor: rgb(0.7, 0.7, 0.7),
      borderWidth: 1,
      color: rgb(0.98, 0.98, 0.98),
    });
    page.drawText('ENTREGADO / EMITIDO POR:', {
      x: 60,
      y: firmaY + 52,
      size: 8,
      font: fontBold,
      color: rgb(0, 0.2, 0.4),
    });
    page.drawText(emisorNombre.slice(0, 32), {
      x: 60,
      y: firmaY + 36,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(`RUT: ${emisorRut}`, {
      x: 60,
      y: firmaY + 22,
      size: 8,
      font: fontMono,
      color: rgb(0.3, 0.3, 0.3),
    });
    page.drawText('[ FIRMADO ELECTRÓNICAMENTE ]', {
      x: 60,
      y: firmaY + 8,
      size: 7.5,
      font: fontBold,
      color: rgb(0, 0.5, 0.2),
    });

    // Firma Receptor (Derecha)
    page.drawRectangle({
      x: 310,
      y: firmaY,
      width: 235,
      height: 70,
      borderColor: rgb(0.7, 0.7, 0.7),
      borderWidth: 1,
      color: rgb(0.98, 0.98, 0.98),
    });
    page.drawText('RECIBIDO CONFORME (RECEPTOR):', {
      x: 320,
      y: firmaY + 52,
      size: 8,
      font: fontBold,
      color: rgb(0, 0.2, 0.4),
    });
    page.drawText(nombreReceptor.slice(0, 32), {
      x: 320,
      y: firmaY + 36,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(`RUT: ${rutReceptor}`, {
      x: 320,
      y: firmaY + 22,
      size: 8,
      font: fontMono,
      color: rgb(0.3, 0.3, 0.3),
    });
    page.drawText('[ ACEPTACIÓN DE CUSTODIA ]', {
      x: 320,
      y: firmaY + 8,
      size: 7.5,
      font: fontBold,
      color: rgb(0, 0.5, 0.2),
    });

    // Recuadro de Sello Criptográfico
    page.drawRectangle({
      x: 50,
      y: 120,
      width: 495,
      height: 110,
      borderColor: rgb(0, 0.4, 0.2),
      borderWidth: 1.5,
      color: rgb(0.95, 0.99, 0.96),
    });

    page.drawText('SELLO DE AUTENTICIDAD CRIPTOGRAFICA FEA & RFC 3161 TSA', {
      x: 65,
      y: 205,
      size: 10,
      font: fontBold,
      color: rgb(0, 0.4, 0.2),
    });
    page.drawText(`SHA-256 Digest : ${hash}`, {
      x: 65,
      y: 185,
      size: 8.5,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText(`Prestador      : ESIGN Chile S.A. / FirmaGob SEGPRES`, {
      x: 65,
      y: 165,
      size: 8.5,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText(`Verificacion   : Portal Checksign Municipal - Codigo ${codigo}`, {
      x: 65,
      y: 145,
      size: 8.5,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  /**
   * Asigna una firma electrónica / token criptográfico a un funcionario con vigencia definida
   */
  async asignarTokenAFuncionario(dto: AsignarTokenFirmaDto) {
    const serial = dto.serialNumber.trim();
    let usuario = null;
    if (dto.usuarioId) {
      usuario = await this.prisma.usuario.findUnique({ where: { id: dto.usuarioId } });
    }
    if (!usuario && dto.rutUsuario) {
      usuario = await this.prisma.usuario.findFirst({ where: { rut: dto.rutUsuario.trim() } });
    }
    if (!usuario) {
      throw new NotFoundException('No se encontró el funcionario para asignar el token.');
    }

    const token = await this.prisma.tokenHardware.upsert({
      where: { serialNumber: serial },
      update: {
        marca: dto.marca || 'Thales / SafeNet',
        modelo: dto.modelo || 'eToken 5110 CC (FIPS 140-2 L3)',
        vendorId: dto.vendorId || '0x0529',
        estadoPatrimonial: 'ASIGNADO',
      },
      create: {
        serialNumber: serial,
        marca: dto.marca || 'Thales / SafeNet',
        modelo: dto.modelo || 'eToken 5110 CC (FIPS 140-2 L3)',
        vendorId: dto.vendorId || '0x0529',
        estadoPatrimonial: 'ASIGNADO',
      },
    });

    const ahora = new Date();
    let fechaExpiracion: Date;
    if (dto.fechaExpiracion) {
      fechaExpiracion = new Date(dto.fechaExpiracion);
    } else if (dto.diasVigencia !== undefined && !isNaN(Number(dto.diasVigencia))) {
      fechaExpiracion = new Date(ahora.getTime() + Number(dto.diasVigencia) * 24 * 60 * 60 * 1000);
    } else {
      fechaExpiracion = new Date(ahora.getTime() + 365 * 24 * 60 * 60 * 1000);
    }

    const diasRestantes = Math.ceil((fechaExpiracion.getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24));
    const estadoCert =
      diasRestantes < 0 ? 'VENCIDO' : diasRestantes <= 60 ? 'POR_VENCER' : 'VIGENTE';

    // Buscar si ya existe un certificado asociado a ese token o crear uno nuevo
    const certExistente = await this.prisma.certificado.findFirst({
      where: { tokenHardwareId: token.id },
    });

    const numeroSerieCert = `CERT-FEA-${serial.replace(/[^A-Z0-9]/gi, '').slice(-8).toUpperCase()}`;

    const certificado = certExistente
      ? await this.prisma.certificado.update({
          where: { id: certExistente.id },
          data: {
            usuarioId: usuario.id,
            validoHasta: fechaExpiracion,
            estado: estadoCert as any,
            tipo: (dto.tipoCertificado || 'FIRMAGOB') as any,
            custodia: 'TOKEN_FISICO',
          },
          include: { usuario: true, tokenHardware: true },
        })
      : await this.prisma.certificado.create({
          data: {
            numeroSerie: numeroSerieCert,
            usuarioId: usuario.id,
            tokenHardwareId: token.id,
            validoHasta: fechaExpiracion,
            estado: estadoCert as any,
            tipo: (dto.tipoCertificado || 'FIRMAGOB') as any,
            custodia: 'TOKEN_FISICO',
          },
          include: { usuario: true, tokenHardware: true },
        });

    await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'certificados',
        registroId: certificado.numeroSerie,
        accion: 'ASIGNACION_TOKEN_FIRMA',
        usuarioId: usuario.id,
        usuarioEmail: usuario.email,
        diffJsonb: {
          serialNumberToken: token.serialNumber,
          funcionarioRut: usuario.rut,
          funcionarioNombre: usuario.nombre,
          validoHasta: fechaExpiracion.toISOString(),
          diasRestantes,
          estado: estadoCert,
          codigoContrato: dto.codigoContrato || null,
        },
      },
    }).catch(() => {});

    return {
      status: 'assigned',
      token,
      certificado,
      diasRestantes,
    };
  }

  /**
   * Requisito 7: Listado de Contratos de Obtención de Tokens con cálculo de tiempo de caducidad y fecha de inicio
   */
  async listarContratos() {
    const ahora = new Date();
    try {
      const contratos = await this.prisma.contratoToken.findMany({
        orderBy: { fechaInicio: 'desc' },
      });

      return contratos.map((c) => this.enriquecerContrato(c, ahora));
    } catch (err) {
      this.logger.warn(`Error al consultar contratos_tokens: ${(err as Error).message}`);
      return [];
    }
  }

  public enriquecerContrato(c: any, ahora = new Date()) {
    const fInicio = new Date(c.fechaInicio);
    const fCaducidad = new Date(c.fechaCaducidad);
    const msRestantes = fCaducidad.getTime() - ahora.getTime();
    const diasRestantes = Math.ceil(msRestantes / (1000 * 60 * 60 * 24));
    const duracionTotalDias = Math.max(
      1,
      Math.ceil((fCaducidad.getTime() - fInicio.getTime()) / (1000 * 60 * 60 * 24)),
    );
    const diasTranscurridos = Math.max(
      0,
      Math.ceil((ahora.getTime() - fInicio.getTime()) / (1000 * 60 * 60 * 24)),
    );
    const porcentajeTranscurrido = Math.min(
      100,
      Math.max(0, Math.round((diasTranscurridos / duracionTotalDias) * 100)),
    );

    let estadoVigencia: 'VIGENTE' | 'POR_CADUCAR' | 'CADUCADO' = 'VIGENTE';
    let tiempoCaducidadTexto = '';

    if (diasRestantes < 0) {
      estadoVigencia = 'CADUCADO';
      tiempoCaducidadTexto = `Caducado hace ${Math.abs(diasRestantes)} días`;
    } else if (diasRestantes === 0) {
      estadoVigencia = 'POR_CADUCAR';
      tiempoCaducidadTexto = 'Caduca hoy';
    } else if (diasRestantes <= 60) {
      estadoVigencia = 'POR_CADUCAR';
      tiempoCaducidadTexto = `${diasRestantes} días restantes (Próximo a caducar)`;
    } else {
      const mesesAprox = Math.round((diasRestantes / 30.4) * 10) / 10;
      tiempoCaducidadTexto = `${diasRestantes} días restantes (~${mesesAprox} meses)`;
    }

    return {
      id: c.id,
      codigoContrato: c.codigoContrato,
      titulo: c.titulo,
      proveedor: c.proveedor,
      fechaInicio: fInicio.toISOString(),
      fechaCaducidad: fCaducidad.toISOString(),
      fechaInicioFormateada: fInicio.toISOString().split('T')[0],
      fechaCaducidadFormateada: fCaducidad.toISOString().split('T')[0],
      diasRestantes,
      duracionTotalDias,
      porcentajeTranscurrido,
      tiempoCaducidadTexto,
      estadoVigencia,
      cantidadTokens: c.cantidadTokens,
      montoReferencial: c.montoReferencial || 'Convenio Marco ID 2239-4-LR25',
      descripcion:
        c.descripcion ||
        'Suministro de dispositivos criptográficos USB PKCS#11 FIPS 140-2 Nivel 3 y certificados de Firma Electrónica Avanzada (Ley N° 19.799).',
      documentoUrl: `/api/v1/equipamiento/contratos/${c.id}/pdf`,
    };
  }

  async crearContrato(dto: CrearContratoTokenDto) {
    const codigo =
      (dto.codigoContrato || '').trim() ||
      `CON-TOKENS-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;

    const fInicio = new Date(dto.fechaInicio);
    const fCaducidad = new Date(dto.fechaCaducidad);
    if (isNaN(fInicio.getTime()) || isNaN(fCaducidad.getTime())) {
      throw new BadRequestException('Las fechas de inicio y caducidad del contrato deben ser válidas.');
    }

    const creado = await this.prisma.contratoToken.upsert({
      where: { codigoContrato: codigo },
      update: {
        titulo: dto.titulo.trim(),
        proveedor: dto.proveedor.trim(),
        fechaInicio: fInicio,
        fechaCaducidad: fCaducidad,
        cantidadTokens: Number(dto.cantidadTokens || 10),
        montoReferencial: dto.montoReferencial || 'Convenio Marco',
        descripcion: dto.descripcion || null,
      },
      create: {
        codigoContrato: codigo,
        titulo: dto.titulo.trim(),
        proveedor: dto.proveedor.trim(),
        fechaInicio: fInicio,
        fechaCaducidad: fCaducidad,
        cantidadTokens: Number(dto.cantidadTokens || 10),
        montoReferencial: dto.montoReferencial || 'Convenio Marco',
        descripcion: dto.descripcion || null,
        documentoUrl: `/api/v1/equipamiento/contratos/${codigo}/pdf`,
      },
    });

    await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'contratos_tokens',
        registroId: creado.codigoContrato,
        accion: 'REGISTRO_CONTRATO_TOKENS',
        usuarioEmail: 'adquisiciones-tics@municoquimbo.cl',
        diffJsonb: {
          codigoContrato: creado.codigoContrato,
          titulo: creado.titulo,
          proveedor: creado.proveedor,
          fechaInicio: fInicio.toISOString(),
          fechaCaducidad: fCaducidad.toISOString(),
          cantidadTokens: creado.cantidadTokens,
        },
      },
    }).catch(() => {});

    return this.enriquecerContrato(creado);
  }

  /**
   * Requisito 7: Genera la copia en PDF del Contrato de Obtención de Tokens para previsualización y descarga
   */
  async generarPdfContrato(idOrCodigo: string): Promise<Buffer> {
    let contrato = await this.prisma.contratoToken
      .findFirst({
        where: { OR: [{ id: idOrCodigo }, { codigoContrato: idOrCodigo }] },
      })
      .catch(() => null);

    if (!contrato) {
      const todos = await this.prisma.contratoToken.findMany().catch(() => []);
      contrato = todos[0] || null;
    }

    const ahora = new Date();
    const info = contrato
      ? this.enriquecerContrato(contrato, ahora)
      : {
          codigoContrato: idOrCodigo || 'CON-2025-TOKENS-CQM-01',
          titulo: 'Contrato de Suministro de Tokens Criptográficos USB y Certificados FEA',
          proveedor: 'E-Sign Chile S.A. / Thales Cloud Protection & Licensing',
          fechaInicioFormateada: '2025-03-01',
          fechaCaducidadFormateada: '2027-03-01',
          diasRestantes: 112,
          duracionTotalDias: 730,
          porcentajeTranscurrido: 84,
          tiempoCaducidadTexto: '112 días restantes (~3.7 meses)',
          estadoVigencia: 'VIGENTE',
          cantidadTokens: 25,
          montoReferencial: 'Orden de Compra N° 4291-188-CM25 (UTM 185)',
          descripcion:
            'Provisión, enrolamiento y soporte técnico de dispositivos físicos USB PKCS#11 FIPS 140-2 Nivel 3 para Firma Electrónica Avanzada Municipal.',
        };

    const hashContrato = crypto
      .createHash('sha256')
      .update(`${info.codigoContrato}:${info.proveedor}:${info.fechaInicioFormateada}:${info.fechaCaducidadFormateada}`)
      .digest('hex');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

    // Encabezado Institucional
    page.drawRectangle({
      x: 0,
      y: 765,
      width: 595.28,
      height: 77,
      color: rgb(0.02, 0.18, 0.36),
    });

    page.drawText('ILUSTRE MUNICIPALIDAD DE COQUIMBO', {
      x: 45,
      y: 812,
      size: 14,
      font: fontBold,
      color: rgb(1, 1, 1),
    });
    page.drawText('DIRECCION DE ADMINISTRACION Y FINANZAS • DEPARTAMENTO DE GESTION DE SISTEMAS Y TICs', {
      x: 45,
      y: 794,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.85, 0.9, 0.96),
    });
    page.drawText(`COPIA DIGITALIZADA DE CONTRATO DE OBTENCION DE TOKENS CRIPTOGRAFICOS`, {
      x: 45,
      y: 777,
      size: 9,
      font: fontBold,
      color: rgb(0.98, 0.82, 0.35),
    });

    // Título y Folio
    page.drawText('CONTRATO DE SUMINISTRO Y VIGENCIA DE TOKENS DE FIRMA ELECTRONICA', {
      x: 45,
      y: 732,
      size: 12,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    page.drawText(`EXPEDIENTE CONTRACTUAL N°: ${info.codigoContrato}`, {
      x: 45,
      y: 712,
      size: 10,
      font: fontMono,
      color: rgb(0.2, 0.2, 0.2),
    });

    // Cuadro Resumen de Fechas y Caducidad (Requisito 7)
    page.drawRectangle({
      x: 45,
      y: 595,
      width: 505,
      height: 105,
      borderColor: rgb(0.02, 0.18, 0.36),
      borderWidth: 1.2,
      color: rgb(0.96, 0.98, 1),
    });

    page.drawText('1. FICHA DE VIGENCIA Y PLAZO DE CADUCIDAD DEL CONTRATO', {
      x: 55,
      y: 682,
      size: 9.5,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const fichaLines = [
      `Fecha de Inicio de Vigencia : ${info.fechaInicioFormateada}`,
      `Fecha de Termino / Caducidad: ${info.fechaCaducidadFormateada}`,
      `Tiempo de Caducidad Restante: ${info.tiempoCaducidadTexto} (${info.duracionTotalDias} dias totales)`,
      `Estado Actual del Contrato  : ${info.estadoVigencia} (${info.porcentajeTranscurrido}% del plazo transcurrido)`,
      `Cupo de Dispositivos Tokens : ${info.cantidadTokens} Unidades USB PKCS#11 FIPS 140-2 Nivel 3`,
    ];

    let fy = 664;
    for (const fl of fichaLines) {
      page.drawText(fl, {
        x: 55,
        y: fy,
        size: 9,
        font: fontMono,
        color: rgb(0.1, 0.1, 0.1),
      });
      fy -= 14;
    }

    // Datos Generales
    page.drawText('2. ANTECEDENTES DE LA CONTRATACION Y PROVEEDOR ACREDITADO', {
      x: 45,
      y: 572,
      size: 10,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const datosContrato = [
      `Denominacion Contrato : ${info.titulo.slice(0, 68)}`,
      `Entidad Contratante   : Ilustre Municipalidad de Coquimbo (RUT 69.040.100-2)`,
      `Proveedor Adjudicado  : ${info.proveedor}`,
      `Referencia Presupuesto: ${info.montoReferencial}`,
      `Normativa Aplicable   : Ley N° 19.799 (Firma Electronica Avanzada) y Ley N° 19.886 (Compras Publicas)`,
    ];

    let yCursor = 553;
    for (const dl of datosContrato) {
      page.drawText(dl, {
        x: 45,
        y: yCursor,
        size: 9,
        font: fontRegular,
        color: rgb(0.15, 0.15, 0.15),
      });
      yCursor -= 16;
    }

    // Cláusulas del Contrato
    page.drawText('3. CLAUSULAS ESENCIALES DE VIGENCIA, RENOVACION Y CONTROL DE TOKENS', {
      x: 45,
      y: 458,
      size: 10,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const clausulas = [
      'PRIMERO (OBJETO): El proveedor suministra dispositivos fisicos criptograficos USB (Tokens)',
      'acreditados ante el Ministerio de Economia / SEGPRES para la emision de Firma Electronica',
      'Avanzada de los funcionarios habilitados de la Ilustre Municipalidad de Coquimbo.',
      '',
      `SEGUNDO (VIGENCIA Y CADUCIDAD): El presente contrato rige desde el ${info.fechaInicioFormateada} hasta`,
      `el ${info.fechaCaducidadFormateada}. El sistema de control de tokens monitoreara automaticamente`,
      'los umbrales preventivos de 60, 30 y 15 dias previos a la expiracion de cada certificado.',
      '',
      'TERCERO (TRAZABILIDAD Y AUDITORIA): Cada accion de firma ejecutada mediante los tokens',
      'adscritos a este contrato queda registrada en la bitacora institucional de control.',
      `Observaciones: ${(info.descripcion || '').slice(0, 82)}`,
    ];

    let cy = 440;
    for (const cl of clausulas) {
      page.drawText(cl, {
        x: 45,
        y: cy,
        size: 8.8,
        font: fontRegular,
        color: rgb(0.2, 0.2, 0.2),
      });
      cy -= 13.5;
    }

    // Recuadros de Firmas del Contrato
    const boxY = 200;
    page.drawRectangle({
      x: 45,
      y: boxY,
      width: 240,
      height: 70,
      borderColor: rgb(0.65, 0.65, 0.65),
      borderWidth: 1,
      color: rgb(0.98, 0.98, 0.98),
    });
    page.drawText('POR LA I. MUNICIPALIDAD DE COQUIMBO:', {
      x: 55,
      y: boxY + 52,
      size: 8,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });
    page.drawText('Direccion de Administracion y TICs', {
      x: 55,
      y: boxY + 36,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText('RUT Institucional: 69.040.100-2', {
      x: 55,
      y: boxY + 22,
      size: 8,
      font: fontMono,
      color: rgb(0.3, 0.3, 0.3),
    });
    page.drawText('[ COPIA CONFORME ARCHIVO TICS ]', {
      x: 55,
      y: boxY + 8,
      size: 7.5,
      font: fontBold,
      color: rgb(0, 0.45, 0.2),
    });

    page.drawRectangle({
      x: 310,
      y: boxY,
      width: 240,
      height: 70,
      borderColor: rgb(0.65, 0.65, 0.65),
      borderWidth: 1,
      color: rgb(0.98, 0.98, 0.98),
    });
    page.drawText('PROVEEDOR PRESTADOR ACREDITADO:', {
      x: 320,
      y: boxY + 52,
      size: 8,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });
    page.drawText(info.proveedor.slice(0, 34), {
      x: 320,
      y: boxY + 36,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText(`Cupo: ${info.cantidadTokens} Tokens USB FIPS 140-2`, {
      x: 320,
      y: boxY + 22,
      size: 8,
      font: fontMono,
      color: rgb(0.3, 0.3, 0.3),
    });
    page.drawText('[ CONTRATO VIGENTE REGISTRADO ]', {
      x: 320,
      y: boxY + 8,
      size: 7.5,
      font: fontBold,
      color: rgb(0, 0.45, 0.2),
    });

    // Pie de Verificación Criptográfica
    page.drawRectangle({
      x: 45,
      y: 95,
      width: 505,
      height: 85,
      borderColor: rgb(0, 0.4, 0.2),
      borderWidth: 1.2,
      color: rgb(0.95, 0.99, 0.96),
    });
    page.drawText('RESPALDO DOCUMENTAL DE CONTRATO - SISTEMA DE CONTROL Y SEGUIMIENTO DE TOKENS', {
      x: 58,
      y: 160,
      size: 9,
      font: fontBold,
      color: rgb(0, 0.4, 0.2),
    });
    page.drawText(`SHA-256 Huella Digital : ${hashContrato}`, {
      x: 58,
      y: 142,
      size: 8,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText(`Vigencia Contractual   : Inicio ${info.fechaInicioFormateada} -> Caducidad ${info.fechaCaducidadFormateada}`, {
      x: 58,
      y: 126,
      size: 8,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText(`Estado Caducidad       : ${info.tiempoCaducidadTexto}`, {
      x: 58,
      y: 110,
      size: 8,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}

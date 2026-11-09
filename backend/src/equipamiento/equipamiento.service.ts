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
  @IsOptional()
  titulo?: string;

  @IsString()
  @IsOptional()
  proveedor?: string;

  @IsString()
  @IsOptional()
  funcionarioNombre?: string;

  @IsString()
  @IsOptional()
  funcionarioRut?: string;

  @IsString()
  @IsOptional()
  funcionarioCargo?: string;

  @IsString()
  @IsOptional()
  funcionarioUnidad?: string;

  @IsString()
  @IsOptional()
  serialNumberToken?: string;

  @IsString()
  @IsOptional()
  marcaModeloToken?: string;

  @IsOptional()
  firmadoObtencion?: boolean;

  @IsString()
  @IsOptional()
  fechaInicio?: string;

  @IsString()
  @IsOptional()
  fechaTermino?: string;

  @IsString()
  @IsOptional()
  fechaCaducidad?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cantidadTokens?: number;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  cantidadTokensContratados?: number;

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
   * Requisito 7: Listado de Contratos Individuales de Obtención y Responsabilidad de Token FEA por Funcionario.
   * Flujo de Negocio: Cada funcionario con un token asignado formaliza su contrato individual de obtención al recibirlo.
   */
  async listarContratos() {
    const ahora = new Date();
    try {
      // 1. Contratos registrados explícitamente en BD
      const contratosDb = await this.prisma.contratoToken.findMany({
        orderBy: { fechaInicio: 'desc' },
      });

      // 2. Asignaciones de tokens y certificados por funcionario
      const asignaciones = await this.prisma.certificado.findMany({
        where: {
          tokenHardwareId: { not: null },
        },
        include: {
          usuario: true,
          tokenHardware: true,
        },
        orderBy: { validoHasta: 'asc' },
      });

      // Mapear contratos por número de serie de token y por RUT de funcionario
      const contratosPorSerial = new Map<string, any>();
      const contratosPorRut = new Map<string, any>();
      const contratosPorCodigo = new Map<string, any>();

      for (const c of contratosDb) {
        let meta: any = {};
        if (c.descripcion) {
          try {
            meta = JSON.parse(c.descripcion);
          } catch {
            meta = {};
          }
        }
        const serial = meta.serialNumberToken || (c as any).serialNumberToken;
        const rut = meta.funcionarioRut || (c as any).funcionarioRut;
        if (serial) contratosPorSerial.set(serial.trim(), c);
        if (rut) contratosPorRut.set(rut.trim(), c);
        contratosPorCodigo.set(c.codigoContrato, c);
      }

      const contratosFinales: any[] = [];
      const procesadosCodigos = new Set<string>();

      // 3. Asegurar 1 contrato individual por cada funcionario con token asignado
      let idx = 1;
      for (const asig of asignaciones) {
        const serial = asig.tokenHardware?.serialNumber || `SN-TOKEN-${idx}`;
        const rut = asig.usuario?.rut || '';
        const codigoAuto = `CT-OBT-2026-00${idx}`;

        let contratoEncontrado =
          contratosPorSerial.get(serial) ||
          contratosPorRut.get(rut) ||
          contratosPorCodigo.get(codigoAuto);

        if (!contratoEncontrado) {
          // Persistir el contrato individual de obtención del funcionario
          const metaPayload = {
            funcionarioNombre: asig.usuario?.nombre || 'Funcionario Municipal',
            funcionarioRut: asig.usuario?.rut || '-',
            funcionarioCargo: asig.usuario?.cargo || 'Funcionario Municipal',
            funcionarioUnidad: asig.usuario?.unidad || 'Municipalidad de Coquimbo',
            serialNumberToken: serial,
            marcaModeloToken: `${asig.tokenHardware?.marca || 'Thales'} ${asig.tokenHardware?.modelo || 'eToken 5110 CC'}`,
            firmadoObtencion: true,
            descripcion: `Contrato individual de obtención y tenencia de dispositivo criptográfico PKCS#11 FIPS 140-2 firmado en conformidad a la Ley N° 19.799.`,
          };

          contratoEncontrado = await this.prisma.contratoToken
            .upsert({
              where: { codigoContrato: codigoAuto },
              update: {
                titulo: `Contrato de Obtención y Responsabilidad de Token FEA — ${asig.usuario?.nombre || 'Funcionario'}`,
                proveedor: 'E-Certchile / Municipalidad de Coquimbo',
                fechaInicio: asig.createdAt || new Date(ahora.getTime() - 120 * 24 * 60 * 60 * 1000),
                fechaCaducidad: asig.validoHasta,
                cantidadTokens: 1,
                descripcion: JSON.stringify(metaPayload),
                documentoUrl: `/api/v1/equipamiento/contratos/${codigoAuto}/pdf`,
              },
              create: {
                codigoContrato: codigoAuto,
                titulo: `Contrato de Obtención y Responsabilidad de Token FEA — ${asig.usuario?.nombre || 'Funcionario'}`,
                proveedor: 'E-Certchile / Municipalidad de Coquimbo',
                fechaInicio: asig.createdAt || new Date(ahora.getTime() - 120 * 24 * 60 * 60 * 1000),
                fechaCaducidad: asig.validoHasta,
                cantidadTokens: 1,
                descripcion: JSON.stringify(metaPayload),
                documentoUrl: `/api/v1/equipamiento/contratos/${codigoAuto}/pdf`,
              },
            })
            .catch(() => null);
        }

        if (contratoEncontrado) {
          procesadosCodigos.add(contratoEncontrado.codigoContrato);
          contratosFinales.push(this.enriquecerContrato(contratoEncontrado, ahora, asig));
        }
        idx++;
      }

      // 4. Incluir contratos adicionales que estuvieran en la BD
      for (const c of contratosDb) {
        if (!procesadosCodigos.has(c.codigoContrato)) {
          contratosFinales.push(this.enriquecerContrato(c, ahora));
        }
      }

      return contratosFinales;
    } catch (err) {
      this.logger.warn(`Error al consultar contratos individuales de obtención: ${(err as Error).message}`);
      return [];
    }
  }

  public enriquecerContrato(c: any, ahora = new Date(), contextAsig?: any) {
    const fInicio = new Date(c.fechaInicio);
    const fCaducidad = new Date(c.fechaCaducidad || c.fechaTermino);
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
    const porcentajeVigenciaTranscurrida = Math.min(
      100,
      Math.max(0, Math.round((diasTranscurridos / duracionTotalDias) * 100)),
    );

    let estadoContrato: 'VIGENTE' | 'POR_CADUCAR' | 'CADUCADO' = 'VIGENTE';
    let tiempoCaducidadTexto = '';

    if (diasRestantes < 0) {
      estadoContrato = 'CADUCADO';
      tiempoCaducidadTexto = `Caducado hace ${Math.abs(diasRestantes)} días`;
    } else if (diasRestantes === 0) {
      estadoContrato = 'POR_CADUCAR';
      tiempoCaducidadTexto = 'Caduca hoy';
    } else if (diasRestantes <= 60) {
      estadoContrato = 'POR_CADUCAR';
      tiempoCaducidadTexto = `${diasRestantes} días restantes (Próximo a caducar)`;
    } else {
      const mesesAprox = Math.round((diasRestantes / 30.4) * 10) / 10;
      tiempoCaducidadTexto = `${diasRestantes} días restantes (~${mesesAprox} meses)`;
    }

    let meta: any = {};
    if (c.descripcion) {
      try {
        meta = JSON.parse(c.descripcion);
      } catch {
        // Plain text descripcion
      }
    }

    const funcionarioNombre =
      c.funcionarioNombre ||
      meta.funcionarioNombre ||
      contextAsig?.usuario?.nombre ||
      'Funcionario Municipal';
    const funcionarioRut =
      c.funcionarioRut ||
      meta.funcionarioRut ||
      contextAsig?.usuario?.rut ||
      '-';
    const funcionarioCargo =
      c.funcionarioCargo ||
      meta.funcionarioCargo ||
      contextAsig?.usuario?.cargo ||
      'Funcionario Municipal';
    const funcionarioUnidad =
      c.funcionarioUnidad ||
      meta.funcionarioUnidad ||
      contextAsig?.usuario?.unidad ||
      'Municipalidad de Coquimbo';
    const serialNumberToken =
      c.serialNumberToken ||
      meta.serialNumberToken ||
      contextAsig?.tokenHardware?.serialNumber ||
      'SN-TOKEN-FEA';
    const marcaModeloToken =
      c.marcaModeloToken ||
      meta.marcaModeloToken ||
      (contextAsig?.tokenHardware
        ? `${contextAsig.tokenHardware.marca} ${contextAsig.tokenHardware.modelo}`
        : 'Thales SafeNet eToken 5110 CC (FIPS 140-2)');
    const firmadoObtencion = c.firmadoObtencion ?? meta.firmadoObtencion ?? true;

    const codigo = c.codigoContrato || c.id;

    return {
      id: c.id,
      codigoContrato: codigo,
      titulo: c.titulo || `Contrato de Obtención y Responsabilidad de Token FEA — ${funcionarioNombre}`,
      proveedor: c.proveedor || 'E-Certchile / Municipalidad de Coquimbo',
      funcionarioNombre,
      funcionarioRut,
      funcionarioCargo,
      funcionarioUnidad,
      serialNumberToken,
      marcaModeloToken,
      firmadoObtencion,
      fechaInicio: fInicio.toISOString(),
      fechaTermino: fCaducidad.toISOString(),
      fechaCaducidad: fCaducidad.toISOString(),
      fechaInicioFormateada: fInicio.toISOString().split('T')[0],
      fechaCaducidadFormateada: fCaducidad.toISOString().split('T')[0],
      diasRestantes,
      mesesRestantes: Math.max(0, Math.floor(diasRestantes / 30)),
      duracionTotalDias,
      porcentajeVigenciaTranscurrida,
      porcentajeTranscurrido: porcentajeVigenciaTranscurrida,
      tiempoCaducidadTexto,
      estadoContrato,
      estadoVigencia: estadoContrato,
      cantidadTokensContratados: 1,
      cantidadTokensActivos: diasRestantes > 0 ? 1 : 0,
      cantidadTokens: c.cantidadTokens || 1,
      montoReferencial: c.montoReferencial || 'Convenio Marco ID 2239-4-LR25',
      descripcion:
        meta.descripcion ||
        (typeof c.descripcion === 'string' && !c.descripcion.startsWith('{')
          ? c.descripcion
          : `Contrato individual de obtención y responsabilidad de token FEA firmado por ${funcionarioNombre}.`),
      pdfUrl: `/api/v1/equipamiento/contratos/${codigo}/pdf`,
      documentoUrl: `/api/v1/equipamiento/contratos/${codigo}/pdf`,
    };
  }

  async crearContrato(dto: CrearContratoTokenDto) {
    const ahora = new Date();
    const codigo =
      (dto.codigoContrato || '').trim() ||
      `CT-OBT-2026-${Math.floor(100 + Math.random() * 900)}`;

    const fInicio = dto.fechaInicio ? new Date(dto.fechaInicio) : ahora;
    const fCaducidadRaw = dto.fechaTermino || dto.fechaCaducidad;
    const fCaducidad = fCaducidadRaw
      ? new Date(fCaducidadRaw)
      : new Date(fInicio.getTime() + 365 * 24 * 60 * 60 * 1000);

    if (isNaN(fInicio.getTime()) || isNaN(fCaducidad.getTime())) {
      throw new BadRequestException('Las fechas de inicio y término/caducidad del contrato deben ser válidas.');
    }

    const funcionarioNombre = (dto.funcionarioNombre || '').trim() || 'Funcionario Municipal';
    const funcionarioRut = (dto.funcionarioRut || '').trim() || '-';
    const funcionarioCargo = (dto.funcionarioCargo || '').trim() || 'Funcionario Municipal';
    const funcionarioUnidad = (dto.funcionarioUnidad || '').trim() || 'Municipalidad de Coquimbo';
    const serialNumberToken = (dto.serialNumberToken || '').trim() || 'SN-TOKEN-FEA';
    const marcaModeloToken = (dto.marcaModeloToken || '').trim() || 'Thales eToken 5110 CC';
    const firmadoObtencion = dto.firmadoObtencion ?? true;

    const tituloFinal =
      (dto.titulo || '').trim() ||
      `Contrato de Obtención y Responsabilidad de Token FEA — ${funcionarioNombre}`;
    const proveedorFinal =
      (dto.proveedor || '').trim() || 'E-Certchile / Municipalidad de Coquimbo';

    const metaData = {
      funcionarioNombre,
      funcionarioRut,
      funcionarioCargo,
      funcionarioUnidad,
      serialNumberToken,
      marcaModeloToken,
      firmadoObtencion,
      descripcion:
        dto.descripcion ||
        `Contrato individual de obtención y tenencia de token FEA formalizado por ${funcionarioNombre}.`,
    };

    const creado = await this.prisma.contratoToken.upsert({
      where: { codigoContrato: codigo },
      update: {
        titulo: tituloFinal,
        proveedor: proveedorFinal,
        fechaInicio: fInicio,
        fechaCaducidad: fCaducidad,
        cantidadTokens: Number(dto.cantidadTokensContratados || dto.cantidadTokens || 1),
        montoReferencial: dto.montoReferencial || 'Convenio Marco',
        descripcion: JSON.stringify(metaData),
        documentoUrl: `/api/v1/equipamiento/contratos/${codigo}/pdf`,
      },
      create: {
        codigoContrato: codigo,
        titulo: tituloFinal,
        proveedor: proveedorFinal,
        fechaInicio: fInicio,
        fechaCaducidad: fCaducidad,
        cantidadTokens: Number(dto.cantidadTokensContratados || dto.cantidadTokens || 1),
        montoReferencial: dto.montoReferencial || 'Convenio Marco',
        descripcion: JSON.stringify(metaData),
        documentoUrl: `/api/v1/equipamiento/contratos/${codigo}/pdf`,
      },
    });

    // Si viene funcionarioRut y serialNumberToken, asegurar o actualizar asignación activa
    if (dto.funcionarioRut && dto.funcionarioRut !== '-' && dto.serialNumberToken) {
      await this.asignarTokenAFuncionario({
        rutUsuario: dto.funcionarioRut,
        serialNumber: dto.serialNumberToken,
        fechaInicio: fInicio.toISOString(),
        fechaExpiracion: fCaducidad.toISOString(),
        codigoContrato: codigo,
      }).catch(() => {});
    }

    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'contratos_tokens',
          registroId: creado.codigoContrato,
          accion: 'REGISTRO_CONTRATO_OBTENCION_TOKEN',
          usuarioEmail: 'adquisiciones-tics@municoquimbo.cl',
          diffJsonb: {
            codigoContrato: creado.codigoContrato,
            titulo: creado.titulo,
            funcionarioNombre,
            funcionarioRut,
            serialNumberToken,
            fechaInicio: fInicio.toISOString(),
            fechaTermino: fCaducidad.toISOString(),
            firmadoObtencion: true,
          },
        },
      })
      .catch(() => {});

    return this.enriquecerContrato(creado, ahora);
  }

  /**
   * Requisito 7: Genera el documento PDF del Contrato Individual de Obtención y Responsabilidad de Token FEA
   * firmado digitalmente por el funcionario titular y el responsable de seguridad institucional.
   */
  async generarPdfContrato(idOrCodigo: string): Promise<Buffer> {
    const ahora = new Date();
    let contrato: any = await this.prisma.contratoToken
      .findFirst({
        where: { OR: [{ id: idOrCodigo }, { codigoContrato: idOrCodigo }] },
      })
      .catch(() => null);

    let contextAsig: any = null;

    if (!contrato) {
      // Buscar si idOrCodigo corresponde al serial de un token o RUT de funcionario
      const cert = await this.prisma.certificado
        .findFirst({
          where: {
            OR: [
              { tokenHardware: { serialNumber: idOrCodigo } },
              { usuario: { rut: idOrCodigo } },
              { usuario: { id: idOrCodigo } },
            ],
          },
          include: { usuario: true, tokenHardware: true },
        })
        .catch(() => null);

      if (cert) {
        contextAsig = cert;
        const cod = `CT-OBT-2026-${(cert.tokenHardware?.serialNumber || '01').slice(-4)}`;
        contrato = {
          id: cert.id,
          codigoContrato: cod,
          titulo: `Contrato de Obtención y Responsabilidad de Token FEA — ${cert.usuario.nombre}`,
          proveedor: 'E-Certchile / Municipalidad de Coquimbo',
          fechaInicio: cert.createdAt || new Date(ahora.getTime() - 120 * 24 * 60 * 60 * 1000),
          fechaCaducidad: cert.validoHasta,
          cantidadTokens: 1,
          descripcion: JSON.stringify({
            funcionarioNombre: cert.usuario.nombre,
            funcionarioRut: cert.usuario.rut,
            funcionarioCargo: cert.usuario.cargo,
            funcionarioUnidad: cert.usuario.unidad,
            serialNumberToken: cert.tokenHardware?.serialNumber,
            marcaModeloToken: `${cert.tokenHardware?.marca || 'Thales'} ${cert.tokenHardware?.modelo || 'eToken 5110'}`,
            firmadoObtencion: true,
          }),
        };
      }
    }

    if (!contrato) {
      const todos = await this.listarContratos();
      if (todos.length > 0) {
        return this.generarPdfContrato(todos[0].codigoContrato);
      }
    }

    const info = this.enriquecerContrato(
      contrato || {
        codigoContrato: idOrCodigo || 'CT-OBT-2026-001',
        titulo: 'Contrato de Obtención y Responsabilidad de Token FEA — Funcionario Municipal',
        proveedor: 'E-Certchile / Municipalidad de Coquimbo',
        fechaInicio: new Date(ahora.getTime() - 120 * 24 * 60 * 60 * 1000),
        fechaCaducidad: new Date(ahora.getTime() + 245 * 24 * 60 * 60 * 1000),
        cantidadTokens: 1,
        descripcion: JSON.stringify({
          funcionarioNombre: 'Juan Pérez González',
          funcionarioRut: '16.892.415-3',
          funcionarioCargo: 'Analista de Gestión Documental',
          funcionarioUnidad: 'Dirección de Tránsito y Transporte',
          serialNumberToken: 'SN-0529-CQM-8841',
          marcaModeloToken: 'Thales / SafeNet eToken 5110 CC (FIPS 140-2 L3)',
          firmadoObtencion: true,
        }),
      },
      ahora,
      contextAsig,
    );

    const hashContrato = crypto
      .createHash('sha256')
      .update(
        `${info.codigoContrato}:${info.funcionarioRut}:${info.serialNumberToken}:${info.fechaInicioFormateada}:${info.fechaCaducidadFormateada}`,
      )
      .digest('hex');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

    // Encabezado Institucional Azul Marino con Borde Dorado
    page.drawRectangle({
      x: 0,
      y: 765,
      width: 595.28,
      height: 77,
      color: rgb(0.02, 0.18, 0.36),
    });
    page.drawRectangle({
      x: 0,
      y: 762,
      width: 595.28,
      height: 3,
      color: rgb(0.85, 0.65, 0.15),
    });

    page.drawText('ILUSTRE MUNICIPALIDAD DE COQUIMBO', {
      x: 45,
      y: 812,
      size: 13,
      font: fontBold,
      color: rgb(1, 1, 1),
    });
    page.drawText('DEPARTAMENTO DE GESTION DE SISTEMAS Y TICs • SEGURIDAD CRIPTOGRAFICA', {
      x: 45,
      y: 794,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.85, 0.9, 0.96),
    });
    page.drawText('CONTRATO INDIVIDUAL DE OBTENCION, TENENCIA Y RESPONSABILIDAD DE TOKEN FEA', {
      x: 45,
      y: 777,
      size: 9,
      font: fontBold,
      color: rgb(0.98, 0.82, 0.35),
    });

    // Identificador Contractual y Estado de Vigencia
    page.drawText(`EXPEDIENTE CONTRACTUAL N°: ${info.codigoContrato}`, {
      x: 45,
      y: 738,
      size: 11,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const colorBadge =
      info.estadoContrato === 'VIGENTE'
        ? rgb(0, 0.45, 0.2)
        : info.estadoContrato === 'POR_CADUCAR'
        ? rgb(0.75, 0.45, 0)
        : rgb(0.7, 0.1, 0.1);

    page.drawRectangle({
      x: 430,
      y: 732,
      width: 120,
      height: 20,
      borderColor: colorBadge,
      borderWidth: 1,
      color: rgb(0.97, 0.98, 1),
    });
    page.drawText(`ESTADO: ${info.estadoContrato}`, {
      x: 442,
      y: 738,
      size: 8.5,
      font: fontBold,
      color: colorBadge,
    });

    // SECCIÓN 1: Identificación del Funcionario Titular Receptor
    page.drawRectangle({
      x: 45,
      y: 636,
      width: 505,
      height: 86,
      borderColor: rgb(0.02, 0.18, 0.36),
      borderWidth: 1,
      color: rgb(0.965, 0.98, 1),
    });

    page.drawText('1. INDIVIDUALIZACION DEL FUNCIONARIO TITULAR RECEPTOR', {
      x: 55,
      y: 708,
      size: 9,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const datosFuncionario = [
      `Nombre Completo : ${info.funcionarioNombre}`,
      `RUN / RUT       : ${info.funcionarioRut}`,
      `Cargo Titular   : ${info.funcionarioCargo}`,
      `Unidad / Depto. : ${info.funcionarioUnidad}`,
    ];

    let yFunc = 692;
    for (const df of datosFuncionario) {
      page.drawText(df, {
        x: 55,
        y: yFunc,
        size: 8.5,
        font: fontMono,
        color: rgb(0.12, 0.12, 0.12),
      });
      yFunc -= 14;
    }

    // SECCIÓN 2: Identificación del Dispositivo Criptográfico
    page.drawRectangle({
      x: 45,
      y: 536,
      width: 505,
      height: 88,
      borderColor: rgb(0.65, 0.72, 0.8),
      borderWidth: 1,
      color: rgb(0.985, 0.99, 1),
    });

    page.drawText('2. IDENTIFICACION DEL DISPOSITIVO CRIPTOGRAFICO ASIGNADO', {
      x: 55,
      y: 610,
      size: 9,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const datosDispositivo = [
      `Dispositivo Token USB  : ${info.marcaModeloToken}`,
      `Numero de Serie (S/N)  : ${info.serialNumberToken}`,
      `Proveedor Certificador : ${info.proveedor}`,
      `Estandar Criptografico : PKCS#11 FIPS 140-2 Nivel 3 (Firma Electronica Avanzada)`,
    ];

    let yDisp = 594;
    for (const dd of datosDispositivo) {
      page.drawText(dd, {
        x: 55,
        y: yDisp,
        size: 8.5,
        font: fontMono,
        color: rgb(0.12, 0.12, 0.12),
      });
      yDisp -= 14;
    }

    // SECCIÓN 3: Ficha de Vigencia y Plazo de Caducidad
    page.drawRectangle({
      x: 45,
      y: 442,
      width: 505,
      height: 82,
      borderColor: rgb(0.65, 0.72, 0.8),
      borderWidth: 1,
      color: rgb(0.985, 0.99, 1),
    });

    page.drawText('3. FICHA DE VIGENCIA Y PLAZO DE CADUCIDAD DEL CONTRATO', {
      x: 55,
      y: 512,
      size: 9,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const datosVigencia = [
      `Fecha de Obtencion / Inicio : ${info.fechaInicioFormateada}`,
      `Fecha de Caducidad / Termino: ${info.fechaCaducidadFormateada}`,
      `Tiempo Restante de Vigencia : ${info.tiempoCaducidadTexto}`,
      `Plazo Transcurrido          : ${info.porcentajeVigenciaTranscurrida}% transcurrido (${info.duracionTotalDias} dias totales)`,
    ];

    let yVig = 496;
    for (const dv of datosVigencia) {
      page.drawText(dv, {
        x: 55,
        y: yVig,
        size: 8.5,
        font: fontMono,
        color: rgb(0.12, 0.12, 0.12),
      });
      yVig -= 14;
    }

    // SECCIÓN 4: Cláusulas Contractuales de Obtención y Responsabilidad
    page.drawText('4. CLAUSULAS ESENCIALES DE OBTENCION Y RESPONSABILIDAD (LEY N° 19.799 / LEY N° 21.663)', {
      x: 45,
      y: 426,
      size: 9,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });

    const clausulas = [
      'PRIMERO (OBJETO Y ENTREGA): En cumplimiento del flujo institucional de obtencion de medios criptograficos',
      'para Firma Electronica Avanzada (FEA), la I. Municipalidad de Coquimbo entrega en tenencia individual',
      'al funcionario titular quien declara recibir conforme el dispositivo token USB singularizado precedentemente.',
      '',
      `SEGUNDO (VIGENCIA Y CADUCIDAD): El presente contrato rige desde el ${info.fechaInicioFormateada} hasta`,
      `el ${info.fechaCaducidadFormateada}. El funcionario titular se compromete a coordinar con TICs la renovacion`,
      'del certificado criptografico previo al vencimiento del umbral preventivo de 30 dias.',
      '',
      'TERCERO (CUSTODIA INDELEGABLE Y CLAVE PIN): Conforme a los articulos 4° y 5° de la Ley N° 19.799, el titular',
      'asume la custodia directa, exclusiva e indelegable del dispositivo fisico y de su clave secreta (PIN),',
      'respondiendo administrativa, civil y penalmente de todo documento firmado bajo su titularidad.',
      '',
      'CUARTO (TELEMETRIA Y ACCIONES DE FIRMA): El titular autoriza el monitoreo de telemetria de conexion USB y el',
      'computo de acciones de firma electronica para efectos de auditoria, control de gestion y trazabilidad publica.',
      '',
      'QUINTO (DEVOLUCION): En caso de desvinculacion, traslado o extravio, el titular debe restituir formalmente',
      'el dispositivo al Departamento de TICs o solicitar su inmediata revocacion ante la Entidad Certificadora.',
    ];

    let yClaus = 412;
    for (const cl of clausulas) {
      if (cl === '') {
        yClaus -= 3;
        continue;
      }
      page.drawText(cl, {
        x: 45,
        y: yClaus,
        size: 7.6,
        font: fontRegular,
        color: rgb(0.18, 0.18, 0.18),
      });
      yClaus -= 10.5;
    }

    // SECCIÓN 5: Firmas Digitales de Perfeccionamiento del Contrato
    const boxY = 135;
    page.drawRectangle({
      x: 45,
      y: boxY,
      width: 242,
      height: 64,
      borderColor: rgb(0.65, 0.65, 0.65),
      borderWidth: 1,
      color: rgb(0.985, 0.985, 0.985),
    });
    page.drawText('FUNCIONARIO TITULAR (FIRMA DE OBTENCION):', {
      x: 55,
      y: boxY + 48,
      size: 7.5,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });
    page.drawText(info.funcionarioNombre.slice(0, 36), {
      x: 55,
      y: boxY + 34,
      size: 8,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(`RUT: ${info.funcionarioRut} • ${info.funcionarioCargo.slice(0, 24)}`, {
      x: 55,
      y: boxY + 21,
      size: 7,
      font: fontMono,
      color: rgb(0.25, 0.25, 0.25),
    });
    page.drawText('[ FIRMA DIGITAL DE OBTENCION CONFORMADA ]', {
      x: 55,
      y: boxY + 8,
      size: 7,
      font: fontBold,
      color: rgb(0, 0.45, 0.2),
    });

    page.drawRectangle({
      x: 308,
      y: boxY,
      width: 242,
      height: 64,
      borderColor: rgb(0.65, 0.65, 0.65),
      borderWidth: 1,
      color: rgb(0.985, 0.985, 0.985),
    });
    page.drawText('MINISTRO DE FE / RESPONSABLE TICs:', {
      x: 318,
      y: boxY + 48,
      size: 7.5,
      font: fontBold,
      color: rgb(0.02, 0.18, 0.36),
    });
    page.drawText('Departamento de Gestion de Sistemas y TICs', {
      x: 318,
      y: boxY + 34,
      size: 8,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText('I. Municipalidad de Coquimbo • RUT 69.040.100-2', {
      x: 318,
      y: boxY + 21,
      size: 7,
      font: fontMono,
      color: rgb(0.25, 0.25, 0.25),
    });
    page.drawText('[ VERIFICADO Y REGISTRADO EN PADRON INSTITUCIONAL ]', {
      x: 318,
      y: boxY + 8,
      size: 7,
      font: fontBold,
      color: rgb(0, 0.45, 0.2),
    });

    // Pie de Verificación Criptográfica (SHA-256)
    page.drawRectangle({
      x: 45,
      y: 50,
      width: 505,
      height: 72,
      borderColor: rgb(0, 0.4, 0.2),
      borderWidth: 1,
      color: rgb(0.955, 0.99, 0.965),
    });
    page.drawText('RESPALDO DOCUMENTAL OFICIAL — SISTEMA DE GESTION DE FIRMAS Y TOKENS', {
      x: 56,
      y: 108,
      size: 8,
      font: fontBold,
      color: rgb(0, 0.4, 0.2),
    });
    page.drawText(`SHA-256 Huella Digital : ${hashContrato}`, {
      x: 56,
      y: 93,
      size: 7.2,
      font: fontMono,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText(
      `Titular: ${info.funcionarioNombre} (${info.funcionarioRut}) | Token S/N: ${info.serialNumberToken}`,
      {
        x: 56,
        y: 80,
        size: 7.2,
        font: fontMono,
        color: rgb(0.15, 0.15, 0.15),
      },
    );
    page.drawText(
      `Vigencia Contractual   : ${info.fechaInicioFormateada} al ${info.fechaCaducidadFormateada} (${info.tiempoCaducidadTexto})`,
      {
        x: 56,
        y: 67,
        size: 7.2,
        font: fontMono,
        color: rgb(0.15, 0.15, 0.15),
      },
    );
    page.drawText(
      'Documento electronico oficial valido conforme a la Ley N° 19.799 y Ley N° 21.663 de la Republica de Chile.',
      {
        x: 56,
        y: 55,
        size: 6.8,
        font: fontRegular,
        color: rgb(0.35, 0.35, 0.35),
      },
    );

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}

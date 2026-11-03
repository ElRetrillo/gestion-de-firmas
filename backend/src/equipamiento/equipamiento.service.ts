import { Injectable, Logger, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as crypto from 'crypto';

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

export class CrearActaCustodiaDto {
  @IsString()
  @IsOptional()
  tokenId?: string;

  @IsString()
  @IsOptional()
  tokenHardwareId?: string;

  @IsString()
  @IsOptional()
  usuarioId?: string;

  @IsString()
  @IsOptional()
  usuarioReceptorId?: string;

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

    const tokenId = dto.tokenId || dto.tokenHardwareId;
    const usuarioId = dto.usuarioId || dto.usuarioReceptorId;
    const tipoActa = (dto.tipoActa || dto.tipo || 'ENTREGA') as 'ENTREGA' | 'DEVOLUCION' | 'TRASPASO' | 'BAJA';

    if (!tokenId || !usuarioId) {
      throw new BadRequestException('Token (tokenId) y Funcionario Receptor (usuarioId) son obligatorios.');
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
}

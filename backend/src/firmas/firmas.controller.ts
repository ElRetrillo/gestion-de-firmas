import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  Res,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Response } from 'express';
import { FirmasService } from './firmas.service';
import {
  CrearSolicitudFirmaDto,
  CrearLoteFirmaDto,
  FirmarSolicitudIndividualDto,
  OtorgarFePublicaDto,
  IngestaArchivoFirmaApiDto,
  GenerarJwtFirmaGobDto,
  FirmaGobV2TicketsRequestDto,
} from './dto/crear-solicitud-firma.dto';
import { Public, Roles } from '../common/auth.guards';

@ApiTags('Orquestación de Firmas y Checksign')
@ApiBearerAuth()
@Controller('api/v1/firmas')
export class FirmasController {
  constructor(private readonly firmasService: FirmasService) {}

  @Post('solicitudes')
  @ApiOperation({ summary: 'Crear nueva solicitud de firma con visación jerárquica' })
  async crearSolicitud(@Body() dto: CrearSolicitudFirmaDto) {
    return this.firmasService.crearSolicitud(dto);
  }

  @Public()
  @Post('ingesta-archivo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ingesta de archivo para firmar desde API/Endpoint (Flujo: Recepción por usuario -> Firma Interna v2 -> Descarga)',
  })
  async ingestarArchivoParaFirma(@Body() dto: IngestaArchivoFirmaApiDto) {
    return this.firmasService.ingestarArchivoParaFirmaApi(dto);
  }

  @Get('solicitudes')
  @ApiOperation({ summary: 'Listar solicitudes de firma para supervisión, bandejas de entrada y Fe Pública' })
  async listarSolicitudes(
    @Query('estado') estado?: string,
    @Query('clasificacion') clasificacion?: string,
    @Query('requiereFePublica') requiereFePublica?: string,
    @Query('rut') rut?: string,
  ) {
    return this.firmasService.listarSolicitudes({
      estado,
      clasificacion,
      requiereFePublica,
      rut,
    });
  }

  @Post('solicitudes/:id/firmar')
  @ApiOperation({
    summary: 'Firmar, visar o rechazar individualmente un documento con Protocolo FirmaGob v2, Token/OTP y Lock Redis',
  })
  async firmarSolicitudIndividual(
    @Param('id') id: string,
    @Body() dto: FirmarSolicitudIndividualDto,
  ) {
    return this.firmasService.firmarSolicitudIndividual(id, dto);
  }

  @Roles('ADMIN', 'MINISTRO_DE_FE')
  @Post('solicitudes/:id/fe-publica')
  @ApiOperation({
    summary: 'Otorgar Atestación de Fe Pública (Ministro de Fe - Secretario Municipal) conforme a Ley N° 18.695',
  })
  async otorgarFePublica(
    @Param('id') id: string,
    @Body() dto: OtorgarFePublicaDto,
  ) {
    return this.firmasService.otorgarFePublica(id, dto);
  }

  @Public()
  @Get('solicitudes/:id/pdf')
  @ApiOperation({
    summary: 'Descargar documento electrónico PDF firmado con incrustación FirmaGob v2 y sello Checksign',
  })
  async descargarPdfDocumento(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.firmasService.generarPdfDocumentoFirmado(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Public()
  @Get('solicitudes/:id/original-pdf')
  @ApiOperation({
    summary: 'Descargar documento PDF original recibido por API (previo a la firma)',
  })
  async descargarPdfOriginal(@Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.firmasService.generarPdfOriginalDocumento(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ============================================================================
  // ENDPOINTS DEL PROTOCOLO FIRMAGOB V2 Y ENTORNO DE PRUEBAS (MANUAL FEB 2026)
  // ============================================================================

  @Get('v2/test-config')
  @ApiOperation({
    summary: 'Configuración del Ambiente de TEST FirmaGob v2, OTP en vivo, estado de Token USB y plantillas JWT/XML',
  })
  async obtenerConfigTestFirmaGob(@Query('rut') rut?: string) {
    return this.firmasService.obtenerConfiguracionTestFirmaGobV2(rut);
  }

  @Post('v2/generar-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generar token JWT HS256 para pruebas del Protocolo FirmaGob v2 (run sin puntos ni DV, entity, purpose, expiration)',
  })
  generarJwtFirmaGob(@Body() dto: GenerarJwtFirmaGobDto) {
    return this.firmasService.generarJwtFirmaGobV2(dto);
  }

  @Post('v2/reset-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reiniciar contador de intentos erróneos de OTP (desbloqueo de error 429 en ambiente de pruebas)',
  })
  async resetOtpFirmaGob(@Body() body?: { run?: string }) {
    return this.firmasService.resetearIntentosOtpFirmaGobV2(body?.run);
  }

  @Public()
  @Post('v2/files/tickets')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'OTP',
    required: false,
    description: 'Código OTP de 6 dígitos (Solo requerido para Firma Atendida - Propósito General; no enviar en Firma Desatendida)',
  })
  @ApiOperation({
    summary: 'Endpoint Oficial Protocolo FirmaGob v2: Firmar Documentos (PDF, XML, JSON, HASH)',
  })
  async procesarTicketsFirmaGob(
    @Body() dto: FirmaGobV2TicketsRequestDto,
    @Headers('otp') otpHeader?: string,
  ) {
    return this.firmasService.procesarTicketFirmaGobV2(dto, otpHeader);
  }

  @Post('lotes/procesar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Orquestar procesamiento masivo por lotes (Batch) en segundo plano',
    description: 'Encola la tarea en BullMQ sobre Redis para procesar firmas asíncronamente con reintentos exponenciales.',
  })
  @ApiResponse({ status: 202, description: 'Lote aceptado y procesado.' })
  async procesarLote(@Body() dto: CrearLoteFirmaDto) {
    return this.firmasService.encolarLoteFirma(dto);
  }

  @Public()
  @Post('checksign/verificar')
  @ApiOperation({
    summary: 'Portal Checksign: Verificación pública de autenticidad e integridad documental',
    description: 'Comprueba el hash criptográfico SHA-256, código de verificación y sellado de tiempo RFC 3161 conforme a la Ley N° 19.799.',
  })
  async verificarChecksign(@Body() body: { hashOTexto: string }) {
    return this.firmasService.verificarDocumentoChecksign(body.hashOTexto || 'DOC-2026-CQM-1420');
  }

  @Public()
  @Get('checksign/:codigo/certificado-pdf')
  @ApiOperation({
    summary: 'Descargar Certificado Oficial PDF de Validación Criptográfica Checksign (Portal Público)',
  })
  async descargarCertificadoChecksign(@Param('codigo') codigo: string, @Res() res: Response) {
    const { buffer, filename } = await this.firmasService.generarPdfCertificadoChecksign(codigo);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }
}

/**
 * Alias de ruta raíz oficial (/firma/v2/files/tickets) idéntico a la especificación de FirmaGob (Pág. 6 y 17)
 */
@ApiTags('Protocolo Oficial FirmaGob v2')
@Controller('firma/v2')
export class FirmaGobProtocoloController {
  constructor(private readonly firmasService: FirmasService) {}

  @Public()
  @Post('files/tickets')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'OTP',
    required: false,
    description: 'Valor OTP (Solo para firma atendida; en firma desatendida no debe enviarse esta cabecera)',
  })
  @ApiOperation({
    summary: 'Protocolo Oficial FirmaGob v2: POST /firma/v2/files/tickets',
  })
  async firmarTicketsProtocoloOficial(
    @Body() dto: FirmaGobV2TicketsRequestDto,
    @Headers('otp') otpHeader?: string,
  ) {
    return this.firmasService.procesarTicketFirmaGobV2(dto, otpHeader);
  }
}

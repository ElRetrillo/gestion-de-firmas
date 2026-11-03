import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { FirmasService } from './firmas.service';
import {
  CrearSolicitudFirmaDto,
  CrearLoteFirmaDto,
  FirmarSolicitudIndividualDto,
  OtorgarFePublicaDto,
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
    summary: 'Firmar, visar o rechazar individualmente un documento con validación de PIN eHSM y Lock Redis',
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

  @Get('solicitudes/:id/pdf')
  @ApiOperation({
    summary: 'Descargar documento electrónico PDF con estampado criptográfico FEA y código Checksign (soporta ?access_token=)',
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

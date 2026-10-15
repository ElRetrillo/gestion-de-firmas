import { Controller, Post, Body, Get, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FirmasService } from './firmas.service';
import { CrearSolicitudFirmaDto, CrearLoteFirmaDto } from './dto/crear-solicitud-firma.dto';

@ApiTags('Orquestación de Firmas y Checksign')
@Controller('api/v1/firmas')
export class FirmasController {
  constructor(private readonly firmasService: FirmasService) {}

  @Post('solicitudes')
  @ApiOperation({ summary: 'Crear nueva solicitud de firma con visación jerárquica' })
  async crearSolicitud(@Body() dto: CrearSolicitudFirmaDto) {
    return this.firmasService.crearSolicitud(dto);
  }

  @Get('solicitudes')
  @ApiOperation({ summary: 'Listar solicitudes de firma para supervisión y bandejas de entrada' })
  async listarSolicitudes() {
    return this.firmasService.listarSolicitudes();
  }

  @Post('lotes/procesar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Orquestar procesamiento masivo por lotes (Batch) en segundo plano',
    description: 'Encola la tarea en BullMQ sobre Redis para procesar firmas asíncronamente con reintentos exponenciales.',
  })
  @ApiResponse({ status: 202, description: 'Lote aceptado y encolado.' })
  async procesarLote(@Body() dto: CrearLoteFirmaDto) {
    return this.firmasService.encolarLoteFirma(dto);
  }

  @Post('checksign/verificar')
  @ApiOperation({
    summary: 'Portal Checksign: Verificación de autenticidad e integridad documental',
    description: 'Comprueba el hash criptográfico SHA-256 y sellado de tiempo RFC 3161 conforme a la Ley N° 19.799.',
  })
  async verificarChecksign(@Body() body: { hashOTexto: string }) {
    return this.firmasService.verificarDocumentoChecksign(body.hashOTexto || 'DOC_DEFAULT');
  }
}

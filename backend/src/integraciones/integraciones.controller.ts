import { Controller, Get, Post, Body, Param, Headers, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { IntegracionesService } from './integraciones.service';
import { Public, Roles } from '../common/auth.guards';

@ApiTags('Integraciones Externas y Webhooks HMAC')
@ApiBearerAuth()
@Controller('api/v1/integraciones')
export class IntegracionesController {
  constructor(private readonly integracionesService: IntegracionesService) {}

  @Roles('ADMIN', 'SUPERVISOR')
  @Get()
  @ApiOperation({ summary: 'Listar conectores externos configurados (FirmaGob, ESIGN, ClaveÚnica)' })
  async listar() {
    return this.integracionesService.listarIntegraciones();
  }

  @Public()
  @Get('estado-adaptadores')
  @ApiOperation({
    summary: 'Módulo 6: Consultar estado de adaptadores externos (SANDBOX_LOCAL vs PRODUCCION_OFICIAL) para FirmaGob, ESIGN, ClaveÚnica y AD',
  })
  async estadoAdaptadores() {
    return this.integracionesService.obtenerEstadoAdaptadores();
  }

  @Get('clasificacion-informacion')
  @ApiOperation({
    summary: 'Módulo 4: Catálogo de clasificación de seguridad documental (tabla clasificacion_informacion)',
  })
  async listarClasificaciones() {
    return this.integracionesService.listarClasificacionesInformacion();
  }

  @Public()
  @Post('webhooks/:servicio')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receptor de Webhooks firmados con HMAC-SHA256 desde ESIGN y FirmaGob (Público, validado por firma criptográfica)',
  })
  async recibirWebhook(
    @Param('servicio') servicio: 'firmagob' | 'esign',
    @Body() payload: Record<string, any>,
    @Headers('x-webhook-signature') signature?: string,
  ) {
    return this.integracionesService.procesarWebhookExterno(servicio, payload, signature);
  }

  @Post('conectores/:sistema/solicitar-firma')
  @ApiOperation({
    summary: 'Módulo 6: Conector para inserción de documentos desde sistemas municipales externos (DOM, SECPLAN, DECRETOS)',
  })
  async solicitarFirmaConector(
    @Param('sistema') sistema: 'DOM' | 'SECPLAN' | 'DECRETOS',
    @Body()
    body: {
      rutSolicitante: string;
      tituloDocumento: string;
      tipoTramite?: string;
      clasificacion?: string;
      documentoUrl?: string;
      requiereFePublica?: boolean;
    },
  ) {
    return this.integracionesService.inyectarSolicitudConectorMunicipal(sistema, body);
  }

  @Public()
  @Get('conectores/sdk.js')
  @ApiOperation({
    summary: 'Módulo 6: SDK JavaScript embebible para insertar botones de firma FEA en sistemas municipales (DOM, SECPLAN, Decretos)',
  })
  descargarSdk(@Res() res: Response) {
    const js = this.integracionesService.generarScriptSdkConector();
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(js);
  }
}

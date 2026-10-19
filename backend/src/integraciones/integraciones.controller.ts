import { Controller, Get, Post, Body, Param, Headers, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IntegracionesService } from './integraciones.service';

@ApiTags('Integraciones Externas y Webhooks HMAC')
@Controller('api/v1/integraciones')
export class IntegracionesController {
  constructor(private readonly integracionesService: IntegracionesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar conectores externos configurados (FirmaGob, ESIGN, ClaveÚnica)' })
  async listar() {
    return this.integracionesService.listarIntegraciones();
  }

  @Post('webhooks/:servicio')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receptor de Webhooks firmados con HMAC-SHA256 desde ESIGN y FirmaGob',
  })
  async recibirWebhook(
    @Param('servicio') servicio: 'firmagob' | 'esign',
    @Body() payload: Record<string, any>,
    @Headers('x-webhook-signature') signature?: string,
  ) {
    return this.integracionesService.procesarWebhookExterno(servicio, payload, signature);
  }
}

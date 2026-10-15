import { Controller, Post, Body, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TelemetriaService } from './telemetria.service';
import { TelemetriaUsbDto } from './dto/telemetria-usb.dto';

@ApiTags('Telemetría USB')
@Controller('api/v1/telemetria')
export class TelemetriaController {
  constructor(private readonly telemetriaService: TelemetriaService) {}

  @Post('usb')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ingesta de telemetría de tokens USB',
    description: 'Endpoint consumido por la Ghost App (Electron en estaciones Windows) para reportar conexión/desconexión de tokens criptográficos.',
  })
  @ApiResponse({ status: 200, description: 'Evento registrado y difundido por WebSocket exitosamente.' })
  async registrarEvento(@Body() dto: TelemetriaUsbDto) {
    return this.telemetriaService.registrarEventoUsb(dto);
  }

  @Get('estaciones')
  @ApiOperation({
    summary: 'Listado de estaciones de trabajo con estado de hardware en tiempo real',
    description: 'Combina persistencia relacional con el estado efímero y TTL de Redis para el Dashboard de Supervisores.',
  })
  async listarEstaciones() {
    return this.telemetriaService.obtenerEstadosEstaciones();
  }

  @Get('eventos-recientes')
  @ApiOperation({
    summary: 'Auditoría forense de eventos de telemetría recientes',
  })
  async listarEventosRecientes() {
    return this.telemetriaService.obtenerUltimosEventos();
  }
}

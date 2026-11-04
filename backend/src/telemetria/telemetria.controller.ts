import { Controller, Post, Body, Get, Query, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { TelemetriaService } from './telemetria.service';
import { TelemetriaUsbDto } from './dto/telemetria-usb.dto';
import { Public, Roles } from '../common/auth.guards';
import * as fs from 'fs';

@ApiTags('Telemetría USB')
@ApiBearerAuth()
@Controller('api/v1/telemetria')
export class TelemetriaController {
  constructor(private readonly telemetriaService: TelemetriaService) {}

  @Public()
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

  @Roles('ADMIN', 'SUPERVISOR')
  @Get('metricas')
  @ApiOperation({
    summary: 'Métricas de trazabilidad, estadísticas operacionales y porcentajes (Por Mes o Últimos 30 días)',
  })
  async obtenerMetricas(
    @Query('modo') modo?: string,
    @Query('mes') mes?: string,
  ) {
    return this.telemetriaService.obtenerMetricasTrazabilidad(modo, mes);
  }

  @Roles('ADMIN')
  @Post('limpiar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Limpia la malla de telemetría en vivo (Redis y registros de estaciones de prueba)',
  })
  async limpiarMalla() {
    return this.telemetriaService.limpiarTelemetria();
  }

  @Public()
  @Get('agente/info')
  @ApiOperation({
    summary: 'Información del instalador en 1 clic del Agente Silencioso USB (Opción 1: Descarga Asistida sin Active Directory)',
  })
  infoInstalador(@Req() req: Request) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.get('host') || 'localhost:3001';
    return this.telemetriaService.obtenerInfoInstaladorAgente(`${proto}://${host}`);
  }

  @Public()
  @Get('descargar-agente')
  @ApiOperation({
    summary: 'Descarga en 1 clic el instalador del Agente Silencioso de Telemetría USB preconfigurado para la estación del funcionario',
  })
  descargarInstaladorAgente(
    @Req() req: Request,
    @Res() res: Response,
    @Query('formato') formato?: string,
    @Query('unidad') unidad?: string,
  ) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.get('host') || 'localhost:3001';
    const paquete = this.telemetriaService.generarPaqueteInstaladorAgente(
      `${proto}://${host}`,
      formato,
      unidad || 'Red Interna Municipal - Coquimbo',
    );

    if (paquete.tipo === 'exe' && paquete.filePath && fs.existsSync(paquete.filePath)) {
      res.set({
        'Content-Type': paquete.contentType,
        'Content-Disposition': `attachment; filename="${paquete.filename}"`,
      });
      const stream = fs.createReadStream(paquete.filePath);
      stream.pipe(res);
      return;
    }

    const buffer = paquete.buffer || Buffer.from('');
    res.set({
      'Content-Type': paquete.contentType,
      'Content-Disposition': `attachment; filename="${paquete.filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }
}

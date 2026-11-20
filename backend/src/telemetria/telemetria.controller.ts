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
  @ApiOperation({ summary: 'Ingesta de telemetría de tokens USB desde Ghost App' })
  @ApiResponse({ status: 200, description: 'Evento registrado y difundido por WebSocket.' })
  async registrarEvento(@Body() dto: TelemetriaUsbDto) {
    return this.telemetriaService.registrarEventoUsb(dto);
  }

  @Public()
  @Get('estaciones')
  @ApiOperation({ summary: 'Listado de estaciones de trabajo con estado de hardware en tiempo real' })
  async listarEstaciones() {
    return this.telemetriaService.obtenerEstadosEstaciones();
  }

  @Public()
  @Get('eventos-recientes')
  @ApiOperation({ summary: 'Últimos eventos de telemetría registrados' })
  async listarEventosRecientes() {
    return this.telemetriaService.obtenerUltimosEventos();
  }

  @Public()
  @Get('metricas')
  @ApiOperation({ summary: 'Métricas de trazabilidad y uso por período (7d, 15d, 30d, 60d, POR_MES, POR_ANIO)' })
  async obtenerMetricas(
    @Query('modo') modo?: string,
    @Query('mes') mes?: string,
  ) {
    return this.telemetriaService.obtenerMetricasTrazabilidad(modo, mes);
  }

  @Roles('ADMIN')
  @Post('limpiar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Limpia la malla de telemetría en vivo (solo ADMIN)' })
  async limpiarMalla() {
    return this.telemetriaService.limpiarTelemetria();
  }

  @Public()
  @Get('agente/info')
  @ApiOperation({ summary: 'Información del instalador del Agente Silencioso USB (Ghost App)' })
  infoInstalador(@Req() req: Request) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.get('host') || 'localhost:3001';
    return this.telemetriaService.obtenerInfoInstaladorAgente(`${proto}://${host}`);
  }

  @Public()
  @Get('descargar-agente')
  @ApiOperation({ summary: 'Descarga instalador del Agente Silencioso USB preconfigurado' })
  descargarInstaladorAgente(
    @Req() req: Request,
    @Res() res: Response,
    @Query('formato') formato?: string,
    @Query('unidad') unidad?: string,
  ) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.get('host') || 'localhost:3001';
    const defaultDep = process.env.DEFAULT_DEPENDENCIA_FISICA || 'Red Interna Municipal - Coquimbo';
    const paquete = this.telemetriaService.generarPaqueteInstaladorAgente(
      `${proto}://${host}`,
      formato,
      unidad || defaultDep,
    );

    if (paquete.tipo === 'exe' && paquete.filePath && fs.existsSync(paquete.filePath)) {
      res.set({
        'Content-Type': paquete.contentType,
        'Content-Disposition': `attachment; filename="${paquete.filename}"`,
      });
      fs.createReadStream(paquete.filePath).pipe(res);
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

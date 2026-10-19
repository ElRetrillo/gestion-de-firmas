import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuditoriaService } from './auditoria.service';

@ApiTags('Auditoría Forense ANCI y Trazabilidad JSONB')
@Controller('api/v1/auditoria')
export class AuditoriaController {
  constructor(private readonly auditoriaService: AuditoriaService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar bitácora de auditoría inalterable (con soporte de filtrado JSONB)',
  })
  async listar(@Query('q') q?: string, @Query('accion') accion?: string) {
    return this.auditoriaService.listarEventosAuditoria(q, accion);
  }

  @Get('estadisticas')
  @ApiOperation({
    summary: 'Métricas de integridad del Ledger de Auditoría e índices GIN PostgreSQL',
  })
  async estadisticas() {
    return this.auditoriaService.obtenerEstadisticasForenses();
  }
}

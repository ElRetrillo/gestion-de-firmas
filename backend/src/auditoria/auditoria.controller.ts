import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditoriaService } from './auditoria.service';
import { Roles } from '../common/auth.guards';

@ApiTags('Auditoría Forense ANCI y Trazabilidad JSONB')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPERVISOR')
@Controller('api/v1/auditoria')
export class AuditoriaController {
  constructor(private readonly auditoriaService: AuditoriaService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar bitácora de auditoría inalterable (Solo ADMIN y SUPERVISOR)',
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

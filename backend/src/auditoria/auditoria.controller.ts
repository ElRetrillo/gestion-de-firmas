import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditoriaService } from './auditoria.service';
import { Roles } from '../common/auth.guards';

@ApiTags('Auditoría')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPERVISOR')
@Controller('api/v1/auditoria')
export class AuditoriaController {
  constructor(private readonly auditoriaService: AuditoriaService) {}

  @Get()
  @ApiOperation({ summary: 'Consultar bitácora de auditoría (Solo ADMIN y SUPERVISOR)' })
  async listar(
    @Query('q') q?: string,
    @Query('accion') accion?: string,
    @Query('modo') modo?: string,
    @Query('mes') mes?: string,
  ) {
    return this.auditoriaService.listarEventosAuditoria(q, accion, modo, mes);
  }

  @Get('estadisticas')
  @ApiOperation({ summary: 'Métricas de integridad de la bitácora de auditoría' })
  async estadisticas() {
    return this.auditoriaService.obtenerEstadisticasForenses();
  }
}

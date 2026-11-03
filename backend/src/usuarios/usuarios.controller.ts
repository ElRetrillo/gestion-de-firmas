import { Controller, Get, Post, Patch, Param, Body, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import {
  UsuariosService,
  CrearUsuarioDto,
  CambiarEstadoUsuarioDto,
  SolicitarModificacionDatosDto,
  ResolverModificacionDatosDto,
} from './usuarios.service';
import { Roles } from '../common/auth.guards';

@ApiTags('Usuarios e Identidades Digitales')
@ApiBearerAuth()
@Controller('api/v1/usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Get()
  @ApiOperation({ summary: 'Listado de funcionarios municipales con filtros por RUT, Nombre o Cargo' })
  @ApiQuery({ name: 'q', required: false, description: 'Búsqueda global (RUT, Nombre, Cargo, Unidad, Email)' })
  @ApiQuery({ name: 'rut', required: false, description: 'Filtrar por RUT' })
  @ApiQuery({ name: 'nombre', required: false, description: 'Filtrar por Nombre' })
  @ApiQuery({ name: 'cargo', required: false, description: 'Filtrar por Cargo' })
  @ApiQuery({ name: 'unidad', required: false, description: 'Filtrar por Unidad' })
  async listar(
    @Query('q') q?: string,
    @Query('rut') rut?: string,
    @Query('nombre') nombre?: string,
    @Query('cargo') cargo?: string,
    @Query('unidad') unidad?: string,
    @Query('limit') limit?: number,
  ) {
    return this.usuariosService.listarUsuarios({ q, rut, nombre, cargo, unidad, limit });
  }

  @Roles('ADMIN')
  @Post()
  @ApiOperation({
    summary: 'Registrar funcionario (solo ADMIN). Con rol=ADMIN se crea un nuevo administrador.',
    description: 'Si no se envía password/pin se generan temporales y se devuelven UNA sola vez (passwordTemporal, pinTemporal).',
  })
  async crear(@Body() dto: CrearUsuarioDto, @Req() req: any) {
    return this.usuariosService.crearUsuario(dto, req.user);
  }

  @Roles('ADMIN')
  @Patch(':id/rol')
  @ApiOperation({ summary: 'Cambiar rol (ADMIN/SUPERVISOR/FUNCIONARIO/MINISTRO_DE_FE). Protege al último admin.' })
  async cambiarRol(@Param('id') id: string, @Body() body: { rol: string }, @Req() req: any) {
    return this.usuariosService.cambiarRol(id, body.rol, req.user);
  }

  @Roles('ADMIN')
  @Post(':id/reset-password')
  @ApiOperation({ summary: 'Restablecer contraseña con clave temporal (solo ADMIN)' })
  async resetPassword(@Param('id') id: string, @Req() req: any) {
    return this.usuariosService.resetPassword(id, req.user);
  }

  @Roles('ADMIN')
  @Patch(':id/estado')
  @ApiOperation({
    summary: 'Actualizar estado del funcionario (incluye protocolo RRHH <48h con revocación inmediata)',
  })
  async cambiarEstado(@Param('id') id: string, @Body() dto: CambiarEstadoUsuarioDto, @Req() req: any) {
    return this.usuariosService.cambiarEstadoUsuario(id, dto, req.user);
  }

  @Get('alertas-vencimiento')
  @ApiOperation({
    summary: 'Alertas preventivas de vencimiento de certificados a 60, 30 y 15 días',
  })
  async alertasVencimiento() {
    return this.usuariosService.obtenerAlertasVencimiento();
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('alertas-vencimiento/despachar')
  @ApiOperation({
    summary: 'Despachar alerta de renovación individual o masiva y registrar en auditoría',
  })
  async despacharAlerta(@Body() body: { certificadoId?: string; email?: string }) {
    return this.usuariosService.despacharNotificacionVencimiento(body.certificadoId, body.email);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('alertas-vencimiento/ejecutar-cron')
  @ApiOperation({
    summary: 'Ejecutar manualmente un ciclo del barrido automático de vencimientos (60, 30 y 15 días)',
  })
  async ejecutarCronVencimientos() {
    return this.usuariosService.ejecutarBarridoAutomaticoVencimientos();
  }

  @Post('solicitudes-modificacion')
  @ApiOperation({
    summary: 'Módulo 5: Registrar solicitud formal de modificación de perfil, cargo, unidad o traslado interno',
  })
  async solicitarModificacion(@Body() dto: SolicitarModificacionDatosDto, @Req() req: any) {
    return this.usuariosService.solicitarModificacionDatos(dto, req.user);
  }

  @Get('solicitudes-modificacion')
  @ApiOperation({
    summary: 'Módulo 5: Listar solicitudes formales de actualización de datos y traslados',
  })
  async listarSolicitudesModificacion() {
    return this.usuariosService.listarSolicitudesModificacion();
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Patch('solicitudes-modificacion/:id/resolver')
  @ApiOperation({
    summary: 'Módulo 5: Aprobar o rechazar solicitud de modificación de datos con registro Audit Trail ANCI',
  })
  async resolverSolicitudModificacion(
    @Param('id') id: string,
    @Body() dto: ResolverModificacionDatosDto,
    @Req() req: any,
  ) {
    return this.usuariosService.resolverSolicitudModificacion(id, dto, req.user);
  }
}

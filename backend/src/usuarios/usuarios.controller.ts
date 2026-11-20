import { Controller, Get, Post, Patch, Param, Body, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import {
  UsuariosService,
  CrearUsuarioDto,
  CambiarEstadoUsuarioDto,
  GenerarCredencialesAdminDto,
} from './usuarios.service';
import { Roles } from '../common/auth.guards';

@ApiTags('Usuarios y Alertas')
@ApiBearerAuth()
@Controller('api/v1/usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Get()
  @ApiOperation({ summary: 'Listado de funcionarios con filtros por RUT, Nombre, Cargo o Unidad' })
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
  @ApiOperation({ summary: 'Registrar funcionario o administrador (solo ADMIN)' })
  async crear(@Body() dto: CrearUsuarioDto, @Req() req: any) {
    return this.usuariosService.crearUsuario(dto, req.user);
  }

  @Roles('ADMIN')
  @Get('admins')
  @ApiOperation({ summary: 'Listar administradores del sistema (solo ADMIN)' })
  async listarAdministradores() {
    return this.usuariosService.listarAdministradores();
  }

  @Roles('ADMIN')
  @Post('admins/generar')
  @ApiOperation({ summary: 'Generar credenciales de administrador o promover usuario existente (solo ADMIN)' })
  async generarCredencialesAdmin(@Body() dto: GenerarCredencialesAdminDto, @Req() req: any) {
    return this.usuariosService.generarCredencialesAdmin(dto, req.user);
  }

  @Roles('ADMIN')
  @Post('admins/:id/revocar')
  @ApiOperation({ summary: 'Revocar facultades de administrador de forma inmediata (solo ADMIN)' })
  async revocarAdministrador(@Param('id') id: string, @Req() req: any) {
    return this.usuariosService.revocarAdministrador(id, req.user);
  }

  @Roles('ADMIN')
  @Patch(':id/rol')
  @ApiOperation({ summary: 'Cambiar rol del usuario (protege al último administrador activo)' })
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
  @ApiOperation({ summary: 'Actualizar estado del funcionario (con revocación inmediata en suspensión/desvinculación)' })
  async cambiarEstado(@Param('id') id: string, @Body() dto: CambiarEstadoUsuarioDto, @Req() req: any) {
    return this.usuariosService.cambiarEstadoUsuario(id, dto, req.user);
  }

  @Get('alertas-vencimiento')
  @ApiOperation({ summary: 'Alertas preventivas de vencimiento de certificados (60, 30 y 15 días)' })
  async alertasVencimiento() {
    return this.usuariosService.obtenerAlertasVencimiento();
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('alertas-vencimiento/despachar')
  @ApiOperation({ summary: 'Previsualizar o despachar aviso de renovación de certificado por SMTP' })
  async despacharAlerta(
    @Body()
    body: {
      certificadoId?: string;
      email?: string;
      nombre?: string;
      rut?: string;
      fechaExpiracion?: string;
      diasRestantes?: number;
      serialNumber?: string;
      masivo?: boolean;
      soloPreview?: boolean;
    },
  ) {
    return this.usuariosService.despacharNotificacionVencimiento(body);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('alertas-vencimiento/ejecutar-cron')
  @ApiOperation({ summary: 'Ejecutar manualmente un ciclo de barrido automático de vencimientos' })
  async ejecutarCronVencimientos() {
    return this.usuariosService.ejecutarBarridoAutomaticoVencimientos();
  }
}

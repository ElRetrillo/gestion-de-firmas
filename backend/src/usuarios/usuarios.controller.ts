import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UsuariosService, CrearUsuarioDto, CambiarEstadoUsuarioDto } from './usuarios.service';

@ApiTags('Usuarios e Identidades Digitales')
@Controller('api/v1/usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Get()
  @ApiOperation({ summary: 'Listado de funcionarios municipales, estado contractual y certificados' })
  async listar() {
    return this.usuariosService.listarUsuarios();
  }

  @Post()
  @ApiOperation({ summary: 'Registrar nuevo funcionario municipal con perfil RBAC y certificado inicial' })
  async crear(@Body() dto: CrearUsuarioDto) {
    return this.usuariosService.crearUsuario(dto);
  }

  @Patch(':id/estado')
  @ApiOperation({
    summary: 'Actualizar estado del funcionario (incluye protocolo RRHH <48h con revocación inmediata)',
  })
  async cambiarEstado(@Param('id') id: string, @Body() dto: CambiarEstadoUsuarioDto) {
    return this.usuariosService.cambiarEstadoUsuario(id, dto);
  }

  @Get('alertas-vencimiento')
  @ApiOperation({
    summary: 'Alertas preventivas de vencimiento de certificados a 60, 30 y 15 días',
  })
  async alertasVencimiento() {
    return this.usuariosService.obtenerAlertasVencimiento();
  }

  @Post('alertas-vencimiento/despachar')
  @ApiOperation({
    summary: 'Despachar alerta de renovación individual o masiva y registrar en auditoría',
  })
  async despacharAlerta(@Body() body: { certificadoId?: string; email?: string }) {
    return this.usuariosService.despacharNotificacionVencimiento(body.certificadoId, body.email);
  }
}

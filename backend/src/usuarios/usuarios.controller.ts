import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UsuariosService } from './usuarios.service';

@ApiTags('Usuarios e Identidades Digitales')
@Controller('api/v1/usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Get()
  @ApiOperation({ summary: 'Listado de funcionarios y estado de sus certificados' })
  async listar() {
    return this.usuariosService.listarUsuarios();
  }

  @Get('alertas-vencimiento')
  @ApiOperation({
    summary: 'Alertas preventivas de vencimiento de certificados a 60, 30 y 15 días',
  })
  async alertasVencimiento() {
    return this.usuariosService.obtenerAlertasVencimiento();
  }
}

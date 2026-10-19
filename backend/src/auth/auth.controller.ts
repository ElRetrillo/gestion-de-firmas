import { Controller, Post, Get, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService, LoginDto, VerificarPinDto, DesbloquearPinDto } from './auth.service';
import { Request } from 'express';

@ApiTags('Autenticación, RBAC y Credenciales de Prueba')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Autenticación institucional por RUT y contraseña (RBAC)',
    description: 'Valida credenciales contra PostgreSQL, verifica que el funcionario no esté desvinculado y emite un token JWT firmado (HS256).',
  })
  @ApiResponse({ status: 200, description: 'Autenticación exitosa con perfil y rol RBAC.' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '10.20.1.10';
    return this.authService.login(dto, ip);
  }

  @Get('credenciales-prueba')
  @ApiOperation({
    summary: 'Obtener matriz de credenciales de prueba para entorno de Desarrollo/Testing',
    description: 'Retorna las cuentas de prueba preconfiguradas por rol (ADMIN, SUPERVISOR, MINISTRO_DE_FE, FUNCIONARIO) y sus PINs de token.',
  })
  obtenerCredencialesPrueba() {
    return this.authService.obtenerCredencialesPrueba();
  }

  @Post('verificar-pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validar PIN de Token Criptográfico USB (con bloqueo tras 3 intentos fallidos)',
  })
  async verificarPin(@Body() dto: VerificarPinDto) {
    return this.authService.verificarPinToken(dto);
  }

  @Post('desbloquear-pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desbloquear PIN de Token USB mediante autorización administrativa TIC (Módulo 5)',
  })
  async desbloquearPin(@Body() dto: DesbloquearPinDto) {
    return this.authService.desbloquearPin(dto);
  }

  @Post('seed-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restaurar y poblar Base de Datos de Prueba (Seed completo)',
  })
  async resetearSeed() {
    return this.authService.resetearBaseDatosPrueba();
  }
}

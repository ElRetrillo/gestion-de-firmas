import { Controller, Post, Get, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import {
  AuthService,
  LoginDto,
  CambiarPasswordDto,
  VerificarTotpDto,
} from './auth.service';
import { Request } from 'express';
import { Public, AllowPasswordChange } from '../common/auth.guards';

function ipDe(req: Request): string {
  return ((req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'desconocida')
    .split(',')[0]
    .trim();
}

@ApiTags('Autenticación')
@ApiBearerAuth()
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Autenticación institucional por RUT, PIN y MFA TOTP (sesión 3h)' })
  @ApiResponse({ status: 200, description: 'Autenticación exitosa o desafío MFA.' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, ipDe(req));
  }

  @AllowPasswordChange()
  @Get('me')
  @ApiOperation({ summary: 'Perfil del usuario autenticado' })
  async me(@Req() req: any) {
    return this.authService.me(req.user.sub);
  }

  @AllowPasswordChange()
  @Post('cambiar-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar PIN o contraseña propia y retornar nueva sesión' })
  async cambiarPassword(@Body() dto: CambiarPasswordDto, @Req() req: any) {
    return this.authService.cambiarPassword(req.user.sub, dto, ipDe(req));
  }

  @AllowPasswordChange()
  @Get('totp/setup')
  @ApiOperation({ summary: 'Obtener configuración 2FA / TOTP (secreto Base32 y URL otpauth://)' })
  async obtenerSetupTotp(@Req() req: any) {
    return this.authService.obtenerSetupTotp(req.user.sub || req.user.rut);
  }

  @AllowPasswordChange()
  @Post('totp/verificar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verificar código OTP TOTP de 6 dígitos' })
  async verificarTotp(@Body() dto: VerificarTotpDto, @Req() req: any) {
    const valido = await this.authService.verificarCodigoTotpUsuario(
      req.user.sub || req.user.rut,
      dto.codigo,
    );
    if (!valido) {
      return { valido: false, mensaje: 'Código OTP inválido o expirado. Verifique la hora en su app.' };
    }
    return { valido: true, mensaje: 'Código OTP validado correctamente.' };
  }

  @Post('totp/regenerar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerar clave secreta TOTP para el usuario autenticado' })
  async regenerarTotp(@Req() req: any) {
    return this.authService.regenerarSecretoTotp(req.user.sub || req.user.rut);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar cierre de sesión en bitácora de auditoría' })
  async logout(@Req() req: any) {
    return this.authService.logout(req.user, ipDe(req));
  }
}

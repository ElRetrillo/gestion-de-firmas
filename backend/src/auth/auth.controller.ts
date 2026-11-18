import { Controller, Post, Get, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import {
  AuthService,
  LoginDto,
  RegistroFuncionarioDto,
  VerificarPinDto,
  DesbloquearPinDto,
  CambiarPasswordDto,
  ClaveUnicaAuthDto,
  VerificarTotpDto,
} from './auth.service';
import { Request } from 'express';
import { Public, Roles, AllowPasswordChange } from '../common/auth.guards';

function ipDe(req: Request): string {
  return ((req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'desconocida')
    .split(',')[0]
    .trim();
}

@ApiTags('Autenticación y RBAC')
@ApiBearerAuth()
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('registro')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registro autónomo de funcionarios (RUT, Nombre, Apellido y Contraseña)',
    description: 'Crea la cuenta en estado PENDIENTE de asignación de rol por el Administrador.',
  })
  async registro(@Body() dto: RegistroFuncionarioDto, @Req() req: Request) {
    return this.authService.registrar(dto, ipDe(req));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Autenticación institucional por RUT y contraseña',
    description: 'Valida credenciales y emite un JWT (HS256, 8h). Si debeCambiarPassword=true solo se permite /auth/cambiar-password.',
  })
  @ApiResponse({ status: 200, description: 'Autenticación exitosa.' })
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
  @ApiOperation({ summary: 'Cambiar contraseña propia (obligatorio en primer ingreso). Retorna nueva sesión.' })
  async cambiarPassword(@Body() dto: CambiarPasswordDto, @Req() req: any) {
    return this.authService.cambiarPassword(req.user.sub, dto, ipDe(req));
  }

  @Post('verificar-pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validar PIN de Token USB (bloqueo tras 3 intentos fallidos)' })
  async verificarPin(@Body() dto: VerificarPinDto, @Req() req: any) {
    return this.authService.verificarPinToken(dto, req.user);
  }

  @Roles('ADMIN')
  @Post('desbloquear-pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desbloquear PIN de Token USB (solo ADMIN)' })
  async desbloquearPin(@Body() dto: DesbloquearPinDto, @Req() req: any) {
    return this.authService.desbloquearPin(dto, req.user);
  }

  @Public()
  @Get('oauth/config')
  @ApiOperation({
    summary: 'Módulo 6: Configuración de proveedores externos (ClaveÚnica OAuth2 y Active Directory) en modo Sandbox o Producción',
  })
  obtenerConfigOAuth() {
    return this.authService.obtenerConfigProveedoresAuth();
  }

  @Public()
  @Post('claveunica/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Módulo 6: Autenticación mediante ClaveÚnica del Estado (OAuth2 / OpenID Connect con fallback Sandbox Local)',
  })
  async loginClaveUnica(@Body() dto: ClaveUnicaAuthDto, @Req() req: Request) {
    return this.authService.loginClaveUnica(dto, ipDe(req));
  }

  @Public()
  @Post('ad/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Módulo 6: Autenticación federada con Active Directory Municipal (LDAP / Kerberos con fallback Sandbox Local)',
  })
  async loginActiveDirectory(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.loginActiveDirectory(dto, ipDe(req));
  }

  @AllowPasswordChange()
  @Get('totp/setup')
  @ApiOperation({
    summary: 'Configuración 2FA / TOTP oficial (Google Authenticator, Microsoft Authenticator, 2FAS)',
    description: 'Retorna clave secreta Base32, URL otpauth:// y lista de aplicaciones móviles para autenticación de dos factores.',
  })
  async obtenerSetupTotp(@Req() req: any) {
    return this.authService.obtenerSetupTotp(req.user.sub || req.user.rut);
  }

  @AllowPasswordChange()
  @Post('totp/verificar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verificar código OTP TOTP dinámico de 6 dígitos' })
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
  @ApiOperation({ summary: 'Regenerar nueva clave secreta TOTP para el funcionario' })
  async regenerarTotp(@Req() req: any) {
    return this.authService.regenerarSecretoTotp(req.user.sub || req.user.rut);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar cierre de sesión (Sign Out) en bitácora de auditoría' })
  async logout(@Req() req: any) {
    return this.authService.logout(req.user, ipDe(req));
  }
}

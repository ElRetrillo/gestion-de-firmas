import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import {
  hashSecret,
  verifySecret,
  validarFortalezaPassword,
} from '../common/crypto.util';
import { formatRut } from '../common/rut.util';
import { JWT_ISSUER } from '../common/auth.guards';
import { evaluarPoliticaRbacFirma } from './rbac-firmas.policy';
import { RedisService } from '../redis/redis.service';
import {
  derivarSecretoUsuario,
  calcularTotp,
  verificarTotp,
  generarOtpauthUrl,
  generarSecretoBase32,
} from '../common/totp.util';

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class VerificarTotpDto {
  @IsString()
  @IsNotEmpty()
  codigo!: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  rut!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @IsOptional()
  rolSimulado?: string;
}

export class VerificarPinDto {
  @IsString()
  @IsNotEmpty()
  rut!: string;

  @IsString()
  @IsNotEmpty()
  pin!: string;
}

export class DesbloquearPinDto {
  @IsString()
  @IsNotEmpty()
  rut!: string;

  @IsString()
  @IsNotEmpty()
  nuevoPin!: string;
}

export class CambiarPasswordDto {
  @IsString()
  @IsNotEmpty()
  passwordActual!: string;

  @IsString()
  @IsNotEmpty()
  passwordNueva!: string;
}

export class RegistroFuncionarioDto {
  @IsString()
  @IsNotEmpty()
  rut!: string;

  @IsString()
  @IsNotEmpty()
  nombre!: string;

  @IsString()
  @IsNotEmpty()
  apellido!: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @IsOptional()
  cargo?: string;

  @IsString()
  @IsOptional()
  unidad?: string;

  @IsString()
  @IsOptional()
  condicionContractual?: string;
}

export class ClaveUnicaAuthDto {
  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  rut?: string;
}

const MAX_INTENTOS_LOGIN = 5;
const VENTANA_BLOQUEO_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  private readonly intentos = new Map<string, { count: number; desde: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', 'secret_key_coquimbo_seguridad_fea_2026');
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 8 * 3600, // 8 horas
        iss: JWT_ISSUER,
      }),
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  private emitirSesion(u: any) {
    const token = this.signJwt({
      sub: u.id,
      rut: u.rut,
      rol: u.rol,
      email: u.email,
      unidad: u.unidad,
      dcp: !!u.debeCambiarPassword,
    });
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: 8 * 3600,
      debeCambiarPassword: !!u.debeCambiarPassword,
      usuario: this.perfilPublico(u),
    };
  }

  perfilPublico(u: any) {
    return {
      id: u.id,
      rut: u.rut,
      nombre: u.nombre,
      email: u.email,
      cargo: u.cargo,
      unidad: u.unidad,
      rol: u.rol,
      estado: u.estado,
      condicionContractual: u.condicionContractual || 'CONTRATA',
      rbac: evaluarPoliticaRbacFirma(u),
      pinBloqueado: u.pinBloqueado,
      debeCambiarPassword: !!u.debeCambiarPassword,
      ...(u.certificados ? { certificados: u.certificados } : {}),
    };
  }

  private chequearBloqueo(rut: string) {
    const reg = this.intentos.get(rut);
    if (!reg) return;
    if (Date.now() - reg.desde > VENTANA_BLOQUEO_MS) {
      this.intentos.delete(rut);
      return;
    }
    if (reg.count >= MAX_INTENTOS_LOGIN) {
      throw new HttpException(
        'Demasiados intentos fallidos. Espere 15 minutos o solicite apoyo a un administrador.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private registrarFallo(rut: string) {
    const reg = this.intentos.get(rut);
    if (!reg || Date.now() - reg.desde > VENTANA_BLOQUEO_MS) {
      this.intentos.set(rut, { count: 1, desde: Date.now() });
    } else {
      reg.count++;
    }
  }

  private async auditar(accion: string, rut: string, usuarioId: string | undefined, email: string, ip: string, diff: object) {
    await this.prisma.historialCambio
      .create({
        data: {
          tablaAfectada: 'usuarios',
          registroId: rut,
          accion,
          usuarioId,
          usuarioEmail: email,
          ipOrigen: ip,
          diffJsonb: { ...diff, timestamp: new Date().toISOString() },
        },
      })
      .catch(() => {});
  }

  async registrar(dto: RegistroFuncionarioDto, ipOrigen = 'desconocida') {
    const rutLimpio = (dto.rut || '').trim();
    if (!rutLimpio || !dto.nombre?.trim() || !dto.apellido?.trim() || !dto.password) {
      throw new BadRequestException('RUT, Nombre, Apellido y Contraseña son obligatorios.');
    }

    const rut = formatRut(rutLimpio) || rutLimpio;
    const nombreCompleto = `${dto.nombre.trim()} ${dto.apellido.trim()}`;
    const emailFinal = (dto.email || `${rut.replace(/[^0-9]/g, '').slice(0, 8)}@municoquimbo.cl`).trim().toLowerCase();

    const existente = await this.prisma.usuario.findFirst({
      where: { OR: [{ rut }, { rut: rutLimpio }, { email: emailFinal }] },
    });
    if (existente) {
      throw new BadRequestException('Ya existe un funcionario registrado con ese RUT o correo.');
    }

    const errPass = validarFortalezaPassword(dto.password);
    if (errPass) throw new BadRequestException(errPass);

    const nuevo = await this.prisma.usuario.create({
      data: {
        rut,
        nombre: nombreCompleto,
        email: emailFinal,
        cargo: (dto.cargo || 'Profesionales').trim(),
        unidad: (dto.unidad || 'I. Municipalidad de Coquimbo').trim(),
        condicionContractual: (dto.condicionContractual || 'CONTRATA').trim().toUpperCase(),
        rol: 'PENDIENTE',
        estado: 'ACTIVO',
        passwordHash: hashSecret(dto.password),
        pinHash: hashSecret('1234'), // PIN estándar inicial
        debeCambiarPassword: false,
      },
    });

    await this.auditar('REGISTRO_AUTONOMO', rut, nuevo.id, nuevo.email, ipOrigen, {
      nombreCompleto,
      rolInicial: 'PENDIENTE',
    });

    return {
      status: 'success',
      mensaje: 'Registro completado con éxito. El Administrador asignará tu rol en el panel para habilitar tu acceso.',
      usuario: this.perfilPublico(nuevo),
    };
  }

  async login(dto: LoginDto, ipOrigen = 'desconocida') {
    const rut = (dto.rut || '').trim();
    if (!rut || !dto.password) {
      throw new BadRequestException('RUT y contraseña son obligatorios.');
    }
    this.chequearBloqueo(rut);

    const rutFormateado = formatRut(rut) || rut;
    const u = await this.prisma.usuario.findFirst({
      where: { OR: [{ rut }, { rut: rutFormateado }] },
      include: { certificados: true },
    });

    // Mensaje genérico para no revelar si el RUT existe.
    if (!u || !verifySecret(dto.password, u.passwordHash)) {
      this.registrarFallo(rut);
      await this.auditar('LOGIN_FALLIDO', rut, u?.id, u?.email || 'desconocido', ipOrigen, {});
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    if (u.estado === 'DESVINCULADO' || u.estado === 'SUSPENDIDO') {
      throw new ForbiddenException(`Cuenta bloqueada. Estado actual: ${u.estado}.`);
    }

    if (u.rol === 'PENDIENTE') {
      throw new ForbiddenException(
        'Tu registro fue recibido exitosamente pero tu cuenta está a la espera de que el Administrador te asigne un rol institucional antes de poder ingresar.',
      );
    }

    this.intentos.delete(rut);
    await this.auditar('LOGIN_EXITOSO', rut, u.id, u.email, ipOrigen, { rol: u.rol, unidad: u.unidad });
    return this.emitirSesion(u);
  }

  async me(userId: string) {
    const u = await this.prisma.usuario.findUnique({
      where: { id: userId },
      include: { certificados: true },
    });
    if (!u) throw new UnauthorizedException('Usuario no encontrado.');
    return this.perfilPublico(u);
  }

  async cambiarPassword(userId: string, dto: CambiarPasswordDto, ip: string) {
    const u = await this.prisma.usuario.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException('Usuario no encontrado.');
    if (!verifySecret(dto.passwordActual, u.passwordHash)) {
      throw new UnauthorizedException('La contraseña actual es incorrecta.');
    }
    const err = validarFortalezaPassword(dto.passwordNueva);
    if (err) throw new BadRequestException(err);
    if (dto.passwordNueva === dto.passwordActual) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual.');
    }
    const actualizado = await this.prisma.usuario.update({
      where: { id: u.id },
      data: { passwordHash: hashSecret(dto.passwordNueva), debeCambiarPassword: false },
      include: { certificados: true },
    });
    await this.auditar('CAMBIO_PASSWORD', u.rut, u.id, u.email, ip, {});
    return this.emitirSesion(actualizado);
  }

  async verificarPinToken(dto: VerificarPinDto, solicitante?: { sub?: string; rol?: string }) {
    const usuario = await this.prisma.usuario.findUnique({ where: { rut: dto.rut } });
    if (!usuario) {
      throw new UnauthorizedException('Funcionario no encontrado para verificación de PIN.');
    }
    if (solicitante && solicitante.sub && solicitante.sub !== usuario.id && solicitante.rol !== 'ADMIN') {
      throw new ForbiddenException('Solo puede verificar su propio PIN.');
    }

    if (usuario.pinBloqueado) {
      throw new ForbiddenException(
        'El PIN del token criptográfico se encuentra BLOQUEADO por intentos fallidos. Solicite desbloqueo a un administrador.',
      );
    }

    if (!verifySecret(dto.pin, usuario.pinHash)) {
      const nuevosIntentos = usuario.intentosPinFallidos + 1;
      const bloquear = nuevosIntentos >= 3;
      await this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { intentosPinFallidos: nuevosIntentos, pinBloqueado: bloquear },
      });
      throw new UnauthorizedException(
        bloquear
          ? 'PIN incorrecto. Token BLOQUEADO tras 3 intentos fallidos.'
          : `PIN incorrecto. Intentos restantes: ${3 - nuevosIntentos}`,
      );
    }

    if (usuario.intentosPinFallidos > 0) {
      await this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { intentosPinFallidos: 0 },
      });
    }

    return { valido: true, mensaje: 'PIN criptográfico validado correctamente.' };
  }

  async desbloquearPin(dto: DesbloquearPinDto, admin: { sub: string; email: string; rut: string }) {
    if (!dto.rut) throw new BadRequestException('RUT obligatorio.');
    if (!dto.nuevoPin || !/^\d{4,8}$/.test(dto.nuevoPin)) {
      throw new BadRequestException('El nuevo PIN debe ser numérico de 4 a 8 dígitos.');
    }
    const objetivo = await this.prisma.usuario.findUnique({ where: { rut: dto.rut } });
    if (!objetivo) throw new NotFoundException(`Funcionario ${dto.rut} no encontrado.`);

    const usuario = await this.prisma.usuario.update({
      where: { rut: dto.rut },
      data: {
        pinBloqueado: false,
        intentosPinFallidos: 0,
        pinHash: hashSecret(dto.nuevoPin),
      },
    });

    await this.prisma.historialCambio.create({
      data: {
        tablaAfectada: 'usuarios',
        registroId: dto.rut,
        accion: 'DESBLOQUEO_PIN_TOKEN',
        usuarioId: admin.sub,
        usuarioEmail: admin.email,
        diffJsonb: {
          rutAfectado: dto.rut,
          pinBloqueadoAnterior: objetivo.pinBloqueado,
          autorizadoPor: admin.rut,
        },
      },
    });

    return {
      status: 'success',
      rut: usuario.rut,
      pinBloqueado: false,
      mensaje: `Token criptográfico de ${usuario.nombre} desbloqueado y PIN restablecido.`,
    };
  }

  async logout(user: any, ipOrigen = 'desconocida') {
    const rut = user?.rut || 'desconocido';
    const email = user?.email || 'desconocido';
    const sub = user?.sub;
    await this.auditar('SIGN_OUT', rut, sub, email, ipOrigen, {
      evento: 'Cierre de sesión del usuario',
    });
    return { status: 'ok', mensaje: 'Sesión cerrada y registrada en bitácora.' };
  }

  /**
   * Módulo 6: Adaptador de Autenticación Unificada (ClaveÚnica OAuth2 + Active Directory).
   * Opera en modo SANDBOX_LOCAL cuando aún no se han aprovisionado las credenciales oficiales en .env,
   * y conmuta automáticamente a PRODUCCION_OFICIAL cuando están presentes.
   */
  obtenerConfigProveedoresAuth() {
    const cuClientId = this.configService.get<string>('CLAVEUNICA_CLIENT_ID', '');
    const cuRedirectUri = this.configService.get<string>(
      'CLAVEUNICA_REDIRECT_URI',
      'http://localhost:5173/auth/claveunica/callback',
    );
    const adLdapUrl = this.configService.get<string>('AD_LDAP_URL', '');

    return {
      claveUnica: {
        habilitado: true,
        modo: cuClientId ? 'PRODUCCION_OFICIAL' : 'SANDBOX_LOCAL',
        authorizeUrl: cuClientId
          ? `https://accounts.claveunica.gob.cl/openid/authorize?client_id=${encodeURIComponent(cuClientId)}&response_type=code&scope=openid%20run%20name&redirect_uri=${encodeURIComponent(cuRedirectUri)}&state=cqm-oauth-2026`
          : '/api/v1/auth/claveunica/sandbox',
      },
      activeDirectory: {
        habilitado: true,
        modo: adLdapUrl ? 'PRODUCCION_OFICIAL' : 'SANDBOX_LOCAL',
        dominio: this.configService.get<string>('AD_DOMAIN', 'MUNICOQUIMBO.LOCAL'),
      },
    };
  }

  async loginClaveUnica(dto: ClaveUnicaAuthDto, ipOrigen = 'desconocida') {
    const cuClientId = this.configService.get<string>('CLAVEUNICA_CLIENT_ID', '');
    const cuClientSecret = this.configService.get<string>('CLAVEUNICA_CLIENT_SECRET', '');
    const cuRedirectUri = this.configService.get<string>('CLAVEUNICA_REDIRECT_URI', '');

    let rutResuelto = dto.rut ? formatRut(dto.rut.trim()) || dto.rut.trim() : '';
    const modo = cuClientId && cuClientSecret ? 'PRODUCCION_OFICIAL' : 'SANDBOX_LOCAL';

    if (modo === 'PRODUCCION_OFICIAL' && dto.code) {
      // Intercambio estándar OpenID Connect con ClaveÚnica del Estado de Chile
      const tokenRes = await fetch('https://accounts.claveunica.gob.cl/openid/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cuClientId,
          client_secret: cuClientSecret,
          redirect_uri: cuRedirectUri,
          grant_type: 'authorization_code',
          code: dto.code,
        }).toString(),
      });

      if (!tokenRes.ok) {
        throw new UnauthorizedException('Error al validar código OAuth2 con ClaveÚnica.');
      }
      const tokenData = (await tokenRes.json()) as { access_token: string };
      const infoRes = await fetch('https://accounts.claveunica.gob.cl/openid/userinfo/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!infoRes.ok) {
        throw new UnauthorizedException('No se pudo obtener el RUN desde ClaveÚnica.');
      }
      const infoData = (await infoRes.json()) as { RolUnico?: { numero: number; DV: string } };
      if (infoData.RolUnico) {
        rutResuelto = formatRut(`${infoData.RolUnico.numero}-${infoData.RolUnico.DV}`);
      }
    }

    const u = rutResuelto
      ? await this.prisma.usuario.findFirst({
          where: { OR: [{ rut: rutResuelto }, { rut: dto.rut || '' }] },
          include: { certificados: true },
        })
      : await this.prisma.usuario.findFirst({
          where: { estado: 'ACTIVO' },
          orderBy: { createdAt: 'asc' },
          include: { certificados: true },
        });

    if (!u) {
      throw new UnauthorizedException(
        `El RUN ${rutResuelto || 'indicado'} no se encuentra registrado como funcionario activo en el padrón municipal.`,
      );
    }

    if (u.estado === 'DESVINCULADO' || u.estado === 'SUSPENDIDO') {
      throw new ForbiddenException(`Cuenta bloqueada. Estado actual: ${u.estado}.`);
    }

    await this.auditar('LOGIN_CLAVEUNICA_OAUTH2', u.rut, u.id, u.email, ipOrigen, {
      modoIntegracion: modo,
      rol: u.rol,
      unidad: u.unidad,
    });

    return {
      ...this.emitirSesion(u),
      proveedorAuth: 'CLAVE_UNICA',
      modoIntegracion: modo,
    };
  }

  async loginActiveDirectory(dto: LoginDto, ipOrigen = 'desconocida') {
    const adLdapUrl = this.configService.get<string>('AD_LDAP_URL', '');
    const modo = adLdapUrl ? 'PRODUCCION_OFICIAL' : 'SANDBOX_LOCAL';

    const sesion = await this.login(dto, ipOrigen);
    await this.auditar(
      'LOGIN_ACTIVE_DIRECTORY',
      sesion.usuario.rut,
      sesion.usuario.id,
      sesion.usuario.email,
      ipOrigen,
      {
        modoIntegracion: modo,
        dominio: this.configService.get<string>('AD_DOMAIN', 'MUNICOQUIMBO.LOCAL'),
      },
    );

    return {
      ...sesion,
      proveedorAuth: 'ACTIVE_DIRECTORY',
      modoIntegracion: modo,
    };
  }

  /**
   * Genera o recupera el secreto TOTP RFC 6238 del funcionario para configurar Google / Microsoft Authenticator
   */
  async obtenerSetupTotp(userIdOrRut: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { OR: [{ id: userIdOrRut }, { rut: userIdOrRut }] },
    });
    if (!usuario) throw new UnauthorizedException('Usuario no encontrado.');

    const redisKey = `user:totp-secret:${usuario.rut}`;
    let secret = await this.redis.getKey(redisKey);
    if (!secret) {
      secret = derivarSecretoUsuario(usuario.rut, this.jwtSecret);
    }

    const otpauthUrl = generarOtpauthUrl({
      cuenta: `${usuario.rut} (${usuario.email})`,
      secretBase32: secret,
      emisor: 'Ilustre Municipalidad de Coquimbo',
    });

    const codigoActual = calcularTotp(secret);

    return {
      rut: usuario.rut,
      nombre: usuario.nombre,
      email: usuario.email,
      secretBase32: secret,
      otpauthUrl,
      codigoActual,
      emisor: 'Ilustre Municipalidad de Coquimbo',
      instrucciones: [
        '1. Descargue Google Authenticator, Microsoft Authenticator o 2FAS en su teléfono.',
        '2. En la app móvil, seleccione "Agregar cuenta" o "+" y luego "Ingresar clave de configuración".',
        `3. En nombre de cuenta escriba "${usuario.email}" y en la clave ingrese: ${secret}`,
        '4. Asegúrese de que el tipo de clave sea "Basada en tiempo" (TOTP 30s).',
        '5. El código de 6 dígitos que aparezca en su aplicación será su OTP dinámico para autorizar firmas.',
      ],
      aplicacionesRecomendadas: [
        {
          nombre: 'Google Authenticator',
          plataformas: 'Android e iOS',
          playStoreUrl: 'https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2',
          appStoreUrl: 'https://apps.apple.com/app/google-authenticator/id388497605',
        },
        {
          nombre: 'Microsoft Authenticator',
          plataformas: 'Android e iOS',
          playStoreUrl: 'https://play.google.com/store/apps/details?id=com.azure.authenticator',
          appStoreUrl: 'https://apps.apple.com/app/microsoft-authenticator/id983156458',
        },
        {
          nombre: '2FAS Authenticator (Open Source)',
          plataformas: 'Android e iOS',
          playStoreUrl: 'https://play.google.com/store/apps/details?id=com.twofasapp',
          appStoreUrl: 'https://apps.apple.com/app/2fas-auth/id1217793794',
        },
      ],
    };
  }

  /**
   * Valida si un código de 6 dígitos ingresado coincide con el OTP TOTP en tiempo real del usuario
   */
  async verificarCodigoTotpUsuario(rutOrUserId: string, codigo: string): Promise<boolean> {
    const cleanQuery = (rutOrUserId || '').replace(/[^0-9kK]/g, '').toUpperCase();
    const usuario = await this.prisma.usuario.findFirst({
      where: {
        OR: [
          { id: rutOrUserId },
          { rut: rutOrUserId },
          ...(cleanQuery.length >= 7 ? [
            { rut: { contains: cleanQuery.slice(0, 8) } },
            { rut: { contains: cleanQuery } }
          ] : [])
        ]
      },
    });
    if (!usuario) return false;

    let secret = await this.redis.getKey(`user:totp-secret:${usuario.rut}`);
    if (!secret) {
      secret = derivarSecretoUsuario(usuario.rut, this.jwtSecret);
    }

    return verificarTotp(secret, codigo, 1, 30);
  }

  /**
   * Regenera un nuevo secreto aleatorio para el usuario y lo almacena en Redis
   */
  async regenerarSecretoTotp(userIdOrRut: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { OR: [{ id: userIdOrRut }, { rut: userIdOrRut }] },
    });
    if (!usuario) throw new UnauthorizedException('Usuario no encontrado.');

    const nuevoSecreto = generarSecretoBase32(20);
    const redisKey = `user:totp-secret:${usuario.rut}`;
    await this.redis.setKey(redisKey, nuevoSecreto, 365 * 86400);

    return this.obtenerSetupTotp(usuario.id);
  }
}

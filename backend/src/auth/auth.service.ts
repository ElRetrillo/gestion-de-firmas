import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  HttpException,
  HttpStatus,
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
import { RedisService } from '../redis/redis.service';
import {
  derivarSecretoUsuario,
  calcularTotp,
  verificarTotp,
  generarOtpauthUrl,
  generarSecretoBase32,
  getTotpIssuer,
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
  codigoTotp?: string;
}

export class CambiarPasswordDto {
  @IsString()
  @IsNotEmpty()
  passwordActual!: string;

  @IsString()
  @IsNotEmpty()
  passwordNueva!: string;

  @IsString()
  @IsOptional()
  codigoTotp?: string;
}

const MAX_INTENTOS_LOGIN = 5;
const VENTANA_BLOQUEO_MS = 15 * 60 * 1000;
const SESSION_TTL_SECONDS = 3 * 3600;

@Injectable()
export class AuthService {
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
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(
      JSON.stringify({
        ...payload,
        iat: now,
        exp: now + SESSION_TTL_SECONDS,
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
      expiresIn: SESSION_TTL_SECONDS,
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
        'Cuenta pendiente de asignación de rol institucional por un Administrador.',
      );
    }

    if (u.debeCambiarPassword) {
      const totpSetup = await this.obtenerSetupTotp(u.id);
      return {
        ...this.emitirSesion(u),
        requiereMfa: true,
        totpSetup,
      };
    }

    if (u.rol === 'ADMIN') {
      if (!dto.codigoTotp || !dto.codigoTotp.trim()) {
        const yaEnrolado = await this.redis.getKey(`user:totp-enrolled:${u.rut}`);
        const totpSetup = yaEnrolado ? undefined : await this.obtenerSetupTotp(u.id);
        return {
          requiereMfa: true,
          rut: u.rut,
          nombre: u.nombre,
          email: u.email,
          totpSetup,
          mensaje: 'Ingrese el código de 6 dígitos de su aplicación Authenticator.',
        };
      }
      const okTotp = await this.verificarCodigoTotpUsuario(u.id, dto.codigoTotp.trim());
      if (!okTotp) {
        throw new UnauthorizedException('Código de Authenticator inválido o expirado.');
      }
      await this.redis.setKey(`user:totp-enrolled:${u.rut}`, '1', 365 * 86400);
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
    if (u.estado === 'SUSPENDIDO' || u.estado === 'DESVINCULADO') {
      throw new UnauthorizedException('Cuenta revocada o suspendida.');
    }
    return this.perfilPublico(u);
  }

  async cambiarPassword(userId: string, dto: CambiarPasswordDto, ip: string) {
    const u = await this.prisma.usuario.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException('Usuario no encontrado.');
    if (!verifySecret(dto.passwordActual, u.passwordHash)) {
      throw new UnauthorizedException('El PIN o contraseña actual es incorrecto.');
    }
    const nuevaClean = (dto.passwordNueva || '').trim();
    const err = validarFortalezaPassword(nuevaClean);
    if (err) throw new BadRequestException(err);
    if (nuevaClean === dto.passwordActual.trim()) {
      throw new BadRequestException('El nuevo PIN debe ser distinto al PIN temporal actual.');
    }
    if (dto.codigoTotp !== undefined) {
      const okTotp = await this.verificarCodigoTotpUsuario(u.id, String(dto.codigoTotp || '').trim());
      if (!okTotp) {
        throw new BadRequestException('Código de Authenticator inválido o expirado. Verifique la hora de su dispositivo.');
      }
      await this.redis.setKey(`user:totp-enrolled:${u.rut}`, '1', 365 * 86400);
    }
    const hashed = hashSecret(nuevaClean);
    const actualizado = await this.prisma.usuario.update({
      where: { id: u.id },
      data: { passwordHash: hashed, pinHash: hashed, debeCambiarPassword: false },
      include: { certificados: true },
    });
    await this.auditar('CAMBIO_PASSWORD', u.rut, u.id, u.email, ip, {});
    return this.emitirSesion(actualizado);
  }

  async logout(user: any, ipOrigen = 'desconocida') {
    const rut = user?.rut || 'desconocido';
    const email = user?.email || 'desconocido';
    await this.auditar('SIGN_OUT', rut, user?.sub, email, ipOrigen, {
      evento: 'Cierre de sesión del usuario',
    });
    return { status: 'ok', mensaje: 'Sesión cerrada y registrada en bitácora.' };
  }

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

    const emisor = getTotpIssuer();
    const otpauthUrl = generarOtpauthUrl({
      cuenta: `${usuario.rut} (${usuario.email})`,
      secretBase32: secret,
      emisor,
    });

    const codigoActual = calcularTotp(secret);

    return {
      rut: usuario.rut,
      nombre: usuario.nombre,
      email: usuario.email,
      secretBase32: secret,
      otpauthUrl,
      codigoActual,
      emisor,
      instrucciones: [
        '1. Descargue Google Authenticator, Microsoft Authenticator o 2FAS en su teléfono.',
        '2. Seleccione "Agregar cuenta" o "+" y escanee el código QR o ingrese la clave manualmente.',
        `3. Nombre de cuenta: "${usuario.email}" | Clave: ${secret}`,
        '4. Verifique que el tipo de clave sea "Basada en tiempo" (TOTP 30s).',
        '5. Ingrese el código dinámico de 6 dígitos generado por su aplicación.',
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

  async verificarCodigoTotpUsuario(rutOrUserId: string, codigo: string): Promise<boolean> {
    const cleanQuery = (rutOrUserId || '').replace(/[^0-9kK]/g, '').toUpperCase();
    const usuario = await this.prisma.usuario.findFirst({
      where: {
        OR: [
          { id: rutOrUserId },
          { rut: rutOrUserId },
          ...(cleanQuery.length >= 7
            ? [
                { rut: { contains: cleanQuery.slice(0, 8) } },
                { rut: { contains: cleanQuery } },
              ]
            : []),
        ],
      },
    });
    if (!usuario) return false;

    let secret = await this.redis.getKey(`user:totp-secret:${usuario.rut}`);
    if (!secret) {
      secret = derivarSecretoUsuario(usuario.rut, this.jwtSecret);
    }

    return verificarTotp(secret, codigo, 1, 30);
  }

  async regenerarSecretoTotp(userIdOrRut: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { OR: [{ id: userIdOrRut }, { rut: userIdOrRut }] },
    });
    if (!usuario) throw new UnauthorizedException('Usuario no encontrado.');

    const nuevoSecreto = generarSecretoBase32(20);
    await this.redis.setKey(`user:totp-secret:${usuario.rut}`, nuevoSecreto, 365 * 86400);
    return this.obtenerSetupTotp(usuario.id);
  }
}

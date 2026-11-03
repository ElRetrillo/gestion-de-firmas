import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Marca una ruta como pública (sin JWT). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
/** Restringe una ruta a ciertos roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
/** Permite acceder aunque el usuario deba cambiar su contraseña (cambiar-password, me). */
export const AllowPasswordChange = () => SetMetadata('allowPasswordChange', true);

export const JWT_ISSUER = 'municoquimbo-tics-anci';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly secret: string;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('JWT_SECRET', '');
  }

  verify(token: string): Record<string, any> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, b, s] = parts;
    const expected = crypto.createHmac('sha256', this.secret).update(`${h}.${b}`).digest();
    let given: Buffer;
    try {
      given = Buffer.from(s, 'base64url');
    } catch {
      return null;
    }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      const header = JSON.parse(Buffer.from(h, 'base64url').toString());
      if (header.alg !== 'HS256') return null;
      const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
      if (payload.iss !== JWT_ISSUER) return null;
      if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    let token: string | undefined;
    const authHeader: string | undefined = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7).trim();

    // Enlaces <a href> de descarga de PDF no pueden enviar cabeceras.
    const path: string = (req.path || req.url || '').split('?')[0];
    if (!token && req.method === 'GET' && /\/(pdf|certificado-pdf)$/.test(path)) {
      token = req.query?.access_token as string | undefined;
    }

    if (!token) throw new UnauthorizedException('Autenticación requerida.');
    const payload = this.verify(token);
    if (!payload) throw new UnauthorizedException('Sesión inválida o expirada.');

    if (payload.dcp) {
      const allow = this.reflector.getAllAndOverride<boolean>('allowPasswordChange', [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allow) {
        throw new ForbiddenException('Debe cambiar su contraseña temporal antes de continuar.');
      }
    }

    req.user = payload;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const user = context.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.rol)) {
      throw new ForbiddenException('No tiene permisos para realizar esta acción.');
    }
    return true;
  }
}

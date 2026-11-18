import * as crypto from 'crypto';

/** Hash de secretos con scrypt. Formato: scrypt$<saltHex>$<hashHex> */
export function hashSecret(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifySecret(plain: string, stored: string): boolean {
  if (!plain || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(plain, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Contraseña temporal aleatoria (sin caracteres ambiguos). */
export function generarPasswordTemporal(longitud = 16): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(longitud);
  let out = '';
  for (let i = 0; i < longitud; i++) out += alfabeto[bytes[i] % alfabeto.length];
  return `${out}#9`;
}

/** PIN numérico aleatorio de 6 dígitos. */
export function generarPin(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function validarFortalezaPassword(pw: string): string | null {
  const clean = (pw || '').trim();
  if (clean.length === 6) return null; // PIN de 6 caracteres a elección del usuario
  if (clean.length < 6) return 'El PIN debe tener exactamente 6 caracteres.';
  if (clean.length < 10) return 'Use un PIN de 6 caracteres o una contraseña de al menos 10 caracteres.';
  return null;
}

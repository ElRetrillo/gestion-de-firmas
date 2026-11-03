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
  if (!pw || pw.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw))
    return 'La contraseña debe incluir mayúsculas, minúsculas y números.';
  return null;
}

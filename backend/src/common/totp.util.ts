import * as crypto from 'crypto';

/**
 * Utilidades para autenticación OTP / TOTP conforme al estándar RFC 6238
 * Compatible con Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis, 2FAS.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodifica una cadena Base32 a Buffer
 */
export function base32Decode(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_ALPHABET.indexOf(clean[i]);
    if (val === -1) continue;
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * Codifica un Buffer a cadena Base32
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Genera un secreto Base32 criptográficamente seguro de 20 bytes (160 bits)
 */
export function generarSecretoBase32(longitudBytes = 20): string {
  const bytes = crypto.randomBytes(longitudBytes);
  return base32Encode(bytes);
}

/**
 * Deriva un secreto TOTP determinístico para un usuario a partir de su RUT y una sal de servidor.
 * Permite que cada usuario tenga un secreto OTP único y reproducible sin necesidad de migraciones de BD.
 */
export function derivarSecretoUsuario(rut: string, serverKey: string): string {
  const hmac = crypto
    .createHmac('sha256', serverKey)
    .update(`COQUIMBO_TOTP_SEED_V2:${rut.trim().toUpperCase()}`)
    .digest();
  // Tomar los primeros 20 bytes para la semilla TOTP (estándar SHA-1)
  return base32Encode(hmac.subarray(0, 20));
}

/**
 * Calcula el código TOTP de 6 dígitos para un instante de tiempo dado (RFC 6238)
 */
export function calcularTotp(
  secretBase32: string,
  timestampMs = Date.now(),
  stepSeconds = 30,
  digits = 6,
): string {
  const key = base32Decode(secretBase32);
  const epoch = Math.floor(timestampMs / 1000);
  const counter = Math.floor(epoch / stepSeconds);

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;

  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    Math.pow(10, digits);

  return String(code).padStart(digits, '0');
}

/**
 * Verifica un código OTP ingresado por el usuario con tolerancia de deriva de reloj (+/- 1 ventana)
 */
export function verificarTotp(
  secretBase32: string,
  codigoIngresado: string,
  ventanaPasos = 1,
  stepSeconds = 30,
): boolean {
  if (!codigoIngresado || !/^\d{6}$/.test(codigoIngresado.trim())) {
    return false;
  }

  const clean = codigoIngresado.trim();
  const now = Date.now();

  for (let paso = -ventanaPasos; paso <= ventanaPasos; paso++) {
    const timestamp = now + paso * stepSeconds * 1000;
    const esperado = calcularTotp(secretBase32, timestamp, stepSeconds, 6);
    if (crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(esperado))) {
      return true;
    }
  }

  return false;
}

/**
 * Construye la URL estándar otpauth:// para escanear en Google / Microsoft Authenticator
 */
export function generarOtpauthUrl(params: {
  cuenta: string;
  emisor?: string;
  secretBase32: string;
}): string {
  const emisor = params.emisor || 'Gestion de tokens - I.Municipalidad de Coquimbo';
  const emisorEncoded = encodeURIComponent(emisor);
  const cuentaEncoded = encodeURIComponent(params.cuenta);
  return `otpauth://totp/${emisorEncoded}:${cuentaEncoded}?secret=${params.secretBase32}&issuer=${emisorEncoded}&algorithm=SHA1&digits=6&period=30`;
}

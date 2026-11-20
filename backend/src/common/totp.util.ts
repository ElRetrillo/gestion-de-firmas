import * as crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function getTotpIssuer(): string {
  return process.env.TOTP_ISSUER || 'Gestion de tokens - I.Municipalidad de Coquimbo';
}

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

export function generarSecretoBase32(longitudBytes = 20): string {
  return base32Encode(crypto.randomBytes(longitudBytes));
}

export function derivarSecretoUsuario(rut: string, serverKey: string): string {
  const hmac = crypto
    .createHmac('sha256', serverKey)
    .update(`COQUIMBO_TOTP_SEED_V2:${rut.trim().toUpperCase()}`)
    .digest();
  return base32Encode(hmac.subarray(0, 20));
}

export function calcularTotp(
  secretBase32: string,
  timestampMs = Date.now(),
  stepSeconds = 30,
  digits = 6,
): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Math.floor(timestampMs / 1000) / stepSeconds);

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

export function generarOtpauthUrl(params: {
  cuenta: string;
  emisor?: string;
  secretBase32: string;
}): string {
  const emisor = params.emisor || getTotpIssuer();
  const emisorEncoded = encodeURIComponent(emisor);
  const cuentaEncoded = encodeURIComponent(params.cuenta);
  return `otpauth://totp/${emisorEncoded}:${cuentaEncoded}?secret=${params.secretBase32}&issuer=${emisorEncoded}&algorithm=SHA1&digits=6&period=30`;
}

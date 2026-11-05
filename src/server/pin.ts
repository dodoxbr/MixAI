import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** PIN da roda: só dígitos, de 4 a 8. */
export const PIN_RE = /^\d{4,8}$/;

const N = 16384;
const KEYLEN = 32;

/** Gera o hash que vai para config/secrets.yaml. O PIN em si nunca é gravado. */
export function hashPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new Error('O PIN deve ter de 4 a 8 dígitos.');
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Confere um PIN contra um hash (tempo constante). Hash inválido = nunca confere. */
export function verifyPin(pin: string, stored: string | undefined): boolean {
  if (!stored || typeof pin !== 'string' || !PIN_RE.test(pin)) return false;
  const [kind, n, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(pin, Buffer.from(saltB64, 'base64'), KEYLEN, { N: Number(n) });
  return timingSafeEqual(actual, expected);
}

export function isValidPinHash(stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  return parts.length === 4 && parts[0] === 'scrypt' && Buffer.from(parts[3]!, 'base64').length === KEYLEN;
}

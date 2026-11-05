import { isIP } from 'node:net';
import type { AppConfig } from '../core/config.js';

export const LOOPBACK = '127.0.0.1';

/** Faixas privadas (rede local). Fora delas = poderia ser internet: recusado. */
export function isPrivateIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Endereços onde o servidor escuta. Sempre 127.0.0.1; o IP da rede local só quando configurado,
 * e só se for um IP específico, privado e diferente do IP da mesa.
 *
 * No Yoga: a mesa fica no cabo (Ethernet) e os celulares no Wi-Fi. O IP a configurar em
 * server.lan.host é o do Wi-Fi do notebook — NUNCA o da mesa (mixer.ip).
 */
export function listenHosts(config: AppConfig): string[] {
  const lan = config.server.lan;
  if (!lan.enabled) return [LOOPBACK];
  const host = lan.host.trim();
  if (!host) throw new Error('server.lan.enabled = true, mas server.lan.host está vazio. Informe o IP do Wi-Fi do notebook.');
  if (host === '0.0.0.0' || host === '::' || host === '*') {
    throw new Error('server.lan.host não pode ser 0.0.0.0/"::" (todas as interfaces). Informe o IP do Wi-Fi do notebook.');
  }
  if (isIP(host) !== 4) throw new Error(`server.lan.host deve ser um IPv4 (recebi "${host}").`);
  if (host.startsWith('127.')) return [LOOPBACK];
  if (!isPrivateIPv4(host)) {
    throw new Error(`server.lan.host ${host} não é de rede local (10.x, 172.16–31.x, 192.168.x). O MixAI não deve ficar exposto à internet.`);
  }
  if (host === config.mixer.ip) {
    throw new Error(
      `server.lan.host (${host}) é o IP da MESA. Use o IP do notebook na rede dos celulares (Wi-Fi), não o endereço da Ui16.`,
    );
  }
  return [LOOPBACK, host];
}

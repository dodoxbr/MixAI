import type { AppConfig } from '../core/config.js';

/** Optional proxy ingress. Validate after CLI overrides, before touching any mixer. */
export function httpsLabOptions(config: AppConfig): { origin: string; port: number } | undefined {
  const proxy = config.server.httpsLab;
  if (!proxy.enabled) return undefined;
  if (config.mixer.mode !== 'lab') throw new Error('HTTPS LAB só pode ser habilitado no modo lab.');
  if (config.server.lan.enabled) throw new Error('HTTPS LAB exige server.lan.enabled=false para evitar acesso HTTP direto pelo Wi-Fi.');
  let origin: URL;
  try { origin = new URL(proxy.origin); }
  catch { throw new Error('HTTPS LAB exige origin HTTPS válido (ex.: https://mixai.home.arpa:8443).'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== proxy.origin) {
    throw new Error('HTTPS LAB origin deve ser uma origem HTTPS exata, sem caminho, credenciais ou barra final.');
  }
  if (proxy.port === 8791 || proxy.port === (config.server.port ?? 8790)) throw new Error('HTTPS LAB: porta reservada ao REAL ou igual à porta HTTP local.');
  return { origin: origin.origin, port: proxy.port };
}

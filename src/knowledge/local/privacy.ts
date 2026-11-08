/**
 * Privacidade para provedores EXTERNOS. O que sai do computador é o mínimo: a pergunta do operador
 * depois de remover dados sensíveis e trechos de fontes PÚBLICAS do catálogo. Documentos locais do
 * operador (fontes "local-*"), PINs, tokens, caminhos, endereços de rede e nomes de pessoas não saem.
 * Puro, sem E/S.
 */
const PLACEHOLDER_PERSON = 'o músico';

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bhttps?:\/\/\S+/gi, '[link]'],
  [/[A-Za-z]:[\\/][^\s"']*/g, '[caminho]'],
  [/(?:^|\s)(?:\/[\w.-]+){2,}/g, ' [caminho]'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
  [/\b[A-Fa-f0-9]{2}(?::[A-Fa-f0-9]{2}){5}\b/g, '[mac]'],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, '[código]'],
  [/\b\d{4,}\b/g, '[número]'],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Texto livre do operador → texto que pode sair. `names` = nomes de pessoas conhecidos (músicos). */
export function redactForExternal(text: string, names: readonly string[] = [], max = 200): string {
  let out = text.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const [re, to] of RULES) out = out.replace(re, to);
  for (const name of new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu'), PLACEHOLDER_PERSON);
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Só fontes públicas do catálogo podem ser citadas a um provedor externo: URL https de verdade e
 * não marcada como documento local. Trechos de documentos que o operador colocou na pasta de ingestão
 * ficam na máquina.
 */
export function isPublicSource(source: { url?: string; local?: boolean } | undefined): boolean {
  if (!source || source.local) return false;
  try {
    const u = new URL(source.url ?? '');
    return u.protocol === 'https:' && u.hostname !== 'local.invalid' && !u.hostname.endsWith('.invalid') && !u.username && !u.password;
  } catch {
    return false;
  }
}

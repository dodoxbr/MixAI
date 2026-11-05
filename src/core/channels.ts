import type { ChannelsConfig, NamedEntry } from './config.js';

/** Minúsculas, sem acento e só letras/números: "Violão 2" -> "violao2". */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Palavras que as pessoas usam antes do nome e que não ajudam a identificar.
const CHANNEL_PREFIXES = ['canal', 'ch', 'entrada', 'input', 'microfone', 'mic', 'do', 'da', 'de', 'o', 'a'];
const AUX_PREFIXES = ['retorno', 'monitor', 'aux', 'fone', 'mix', 'do', 'da', 'de', 'dos', 'das', 'o', 'a'];

function stripPrefixes(text: string, prefixes: string[]): string {
  let words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && prefixes.includes(words[0]!)) words = words.slice(1);
  return words.join('');
}

export interface Resolved {
  number: number;
  name: string;
}

export type NameErrorCode = 'NOT_FOUND' | 'NOT_CONFIGURED' | 'INVALID';

export class NameResolutionError extends Error {
  constructor(
    message: string,
    readonly code: NameErrorCode = 'NOT_FOUND',
  ) {
    super(message);
  }
}

class Directory {
  private byKey = new Map<string, NamedEntry>();

  constructor(
    private entries: NamedEntry[],
    private max: number,
    private kind: 'canal' | 'retorno',
    private prefixes: string[],
    private allowUnmapped: boolean,
  ) {
    for (const e of entries) {
      for (const key of [e.name, ...e.aliases, String(e.number)]) {
        const k = normalize(key);
        if (k && !this.byKey.has(k)) this.byKey.set(k, e);
      }
    }
  }

  nameOf(number: number): string {
    const e = this.entries.find((x) => x.number === number);
    if (e) return e.name;
    return this.kind === 'canal' ? `Canal ${number}` : `AUX ${number}`;
  }

  list(): Resolved[] {
    return this.entries.map((e) => ({ number: e.number, name: e.name }));
  }

  /** Números cadastrados no channels.yaml (dentro dos limites da mesa). */
  configured(): number[] {
    return [...new Set(this.entries.map((e) => e.number))].filter((n) => n >= 1 && n <= this.max).sort((a, b) => a - b);
  }

  /** Números que podem ser resolvidos (configurados, ou todos se allowUnmapped). */
  resolvable(): number[] {
    return this.allowUnmapped ? Array.from({ length: this.max }, (_, i) => i + 1) : this.configured();
  }

  resolve(query: string | number): Resolved {
    const raw = String(query).trim();
    if (!raw) throw new NameResolutionError(`Informe qual ${this.kind}.`, 'INVALID');

    const candidates = [normalize(raw), stripPrefixes(raw, this.prefixes)];
    for (const c of candidates) {
      const hit = this.byKey.get(c);
      if (hit) return this.check({ number: hit.number, name: hit.name });
    }
    // "canal 7", "aux 3", "7": aceita número direto, mesmo sem apelido.
    const numeric = candidates.map((c) => /^\d+$/.test(c) ? Number(c) : NaN).find((n) => !Number.isNaN(n));
    if (numeric !== undefined) {
      const r = this.check({ number: numeric, name: this.nameOf(numeric) });
      if (!this.allowUnmapped && !this.entries.some((e) => e.number === r.number)) {
        const known = this.entries.map((e) => `${e.name} (${e.number})`).join(', ') || 'nenhum';
        throw new NameResolutionError(
          `O ${this.kind} ${r.number} não está configurado no channels.yaml, então não mexo nele. Configurados: ${known}.`,
          'NOT_CONFIGURED',
        );
      }
      return r;
    }

    const known = this.entries.map((e) => e.name).join(', ') || 'nenhum nome cadastrado';
    throw new NameResolutionError(`Não reconheci o ${this.kind} "${raw}". Nomes conhecidos: ${known}.`);
  }

  private check(r: Resolved): Resolved {
    if (r.number < 1 || r.number > this.max) {
      throw new NameResolutionError(`O ${this.kind} ${r.number} não existe nesta mesa (vai de 1 a ${this.max}).`, 'INVALID');
    }
    return r;
  }
}

/** Traduz os nomes da banda ("voz 2", "retorno do cavaco") para números de canal e AUX. */
export class ChannelMap {
  readonly inputs: Directory;
  readonly aux: Directory;

  /**
   * @param options.allowUnmapped aceita canais/AUX só pelo número, mesmo sem estar no channels.yaml.
   *   O padrão da classe é true (compatível com a v0.1); a aplicação usa `naming.allowUnmapped`
   *   do config.yaml, cujo padrão é false.
   */
  constructor(config: ChannelsConfig, limits: { inputs: number; aux: number }, options: { allowUnmapped?: boolean } = {}) {
    const allow = options.allowUnmapped ?? true;
    this.inputs = new Directory(config.channels, limits.inputs, 'canal', CHANNEL_PREFIXES, allow);
    this.aux = new Directory(config.aux, limits.aux, 'retorno', AUX_PREFIXES, allow);
  }

  channel(query: string | number): Resolved {
    return this.inputs.resolve(query);
  }
  auxBus(query: string | number): Resolved {
    return this.aux.resolve(query);
  }
}

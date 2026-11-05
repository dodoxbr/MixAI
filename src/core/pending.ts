import { createHash, randomBytes } from 'node:crypto';
import type { ParamKey } from './revisions.js';

export type PendingFailure =
  | 'NOT_FOUND'
  | 'CONFIRMATION_USED'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_MISMATCH'
  | 'CONFIRMATION_STALE';

interface Pending {
  id: string;
  hash: string;
  revisions: Array<[ParamKey, number]>;
  summary: string;
  expiresAt: number;
  /** Usada com sucesso, ou invalidada por uma tentativa errada: não serve mais. */
  closed: boolean;
}

/** Hash estável do comando normalizado (ordem das chaves não importa). */
export function commandHash(command: unknown): string {
  const stable = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, stable(x)]),
        )
      : Array.isArray(v)
        ? v.map(stable)
        : typeof v === 'number' && !Number.isFinite(v)
          ? String(v)
          : v;
  return createHash('sha256').update(JSON.stringify(stable(command))).digest('hex');
}

/**
 * Pendências de autorização: vinculadas ao comando (hash) E ao estado em que ele foi calculado
 * (revisões dos parâmetros envolvidos). Uso único, com validade.
 *
 * Limite da E0: o id não prova que um humano aprovou (a IA pode reenviá-lo). Ele garante que só
 * é executado exatamente o que foi avaliado, sobre o estado avaliado, uma vez, dentro do prazo.
 */
export class PendingStore {
  private items = new Map<string, Pending>();

  constructor(
    private ttlMs = 60_000,
    private clock: () => number = Date.now,
    private newId: () => string = () => randomBytes(4).toString('hex'),
  ) {}

  create(hash: string, revisions: Array<[ParamKey, number]>, summary: string): { id: string; expiresInSec: number } {
    this.prune();
    let id = this.newId();
    while (this.items.has(id)) id = this.newId();
    this.items.set(id, { id, hash, revisions, summary, expiresAt: this.clock() + this.ttlMs, closed: false });
    return { id, expiresInSec: Math.round(this.ttlMs / 1000) };
  }

  /** Confere e consome. Qualquer falha (exceto id inexistente) invalida a pendência. */
  consume(
    id: string,
    hash: string,
    revisionOf: (key: ParamKey) => number,
  ): { ok: true } | { ok: false; code: PendingFailure; message: string } {
    const p = this.items.get(id);
    if (!p) return { ok: false, code: 'NOT_FOUND', message: `Confirmação "${id}" não encontrada. Peça de novo.` };
    if (p.closed) return { ok: false, code: 'CONFIRMATION_USED', message: 'Esta confirmação já foi usada ou invalidada. Peça de novo.' };
    p.closed = true;
    if (this.clock() > p.expiresAt) {
      return { ok: false, code: 'CONFIRMATION_EXPIRED', message: 'A confirmação expirou. Peça de novo.' };
    }
    if (p.hash !== hash) {
      return {
        ok: false,
        code: 'CONFIRMATION_MISMATCH',
        message: 'A confirmação não corresponde a este comando. Nada foi alterado; peça de novo.',
      };
    }
    const changed = p.revisions.filter(([key, rev]) => revisionOf(key) !== rev).map(([key]) => key);
    if (changed.length) {
      return {
        ok: false,
        code: 'CONFIRMATION_STALE',
        message: 'O estado da mesa mudou depois que a confirmação foi pedida. Nada foi alterado; peça de novo para recalcular.',
      };
    }
    return { ok: true };
  }

  private prune() {
    const now = this.clock();
    for (const [id, p] of this.items) if (now - p.expiresAt > 10 * 60_000) this.items.delete(id);
  }
}

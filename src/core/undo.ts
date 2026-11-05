import type { Actor, ParamKey, ParamValue } from './revisions.js';

export interface UndoItem {
  key: ParamKey;
  label: string;
  before: ParamValue;
  after: ParamValue;
  /** Revisão que a escrita do MixAI gerou neste parâmetro. */
  revisionAtWrite: number;
  /** Revisão do parâmetro imediatamente antes da escrita. */
  revisionBefore: number;
  /** Quem fez a revisão anterior à escrita (para explicar conflitos). */
  actorBefore?: Actor;
  /** Preenchido quando o encadeamento causal é interrompido: quem alterou entre as ações. */
  blockedBy?: Actor;
}

export interface UndoEntry {
  description: string;
  items: UndoItem[];
}

/**
 * Pilha de desfazer com encadeamento causal: depois de desfazer um item, o item anterior do
 * MESMO parâmetro passa a apontar para a revisão gerada pelo desfazer, mas só se nada aconteceu
 * entre as duas escritas do MixAI. Assim três alterações seguidas podem ser desfeitas em
 * sequência, e uma mudança externa no meio continua bloqueando.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];

  constructor(private limit = 50) {}

  push(entry: UndoEntry) {
    if (!entry.items.length) return;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  pop(): UndoEntry | undefined {
    return this.entries.pop();
  }

  size(): number {
    return this.entries.length;
  }

  clear() {
    this.entries = [];
  }

  /** Item desfeito com sucesso: liga o item anterior do mesmo parâmetro à nova revisão. */
  relink(undone: UndoItem, newRevision: number) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const prev = this.entries[i]!.items.find((it) => it.key === undone.key);
      if (!prev) continue;
      if (prev.revisionAtWrite === undone.revisionBefore) prev.revisionAtWrite = newRevision;
      else prev.blockedBy ??= undone.actorBefore ?? 'external';
      return; // só o mais próximo
    }
  }
}

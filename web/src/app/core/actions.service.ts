import { SessionService } from './session.service';
import type { OperationReceipt } from '../live-ux/operation-view';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { LiveService } from './live.service';
import { newId, type Result } from './protocol';

/**
 * Ações da tela com retorno imediato: marca o botão como ocupado, manda ao servidor e mostra o
 * resultado. Nenhuma regra de permissão aqui: o servidor decide.
 */
@Injectable({ providedIn: 'root' })
export class ActionsService {
  private readonly live = inject(LiveService);
  private readonly session = inject(SessionService);
  readonly receipt = signal<OperationReceipt | null>(null);
  constructor() { effect(() => { this.session.token(); this.live.hello()?.serverId; untracked(() => this.receipt.set(null)); }); }
  /** Ações em andamento (chave livre: "mute:3", "fones:5:+", "undo"...). */
  readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Pendência sendo aprovada/recusada. */
  readonly deciding = signal<string | null>(null);

  isBusy(key: string): boolean {
    return this.busy().has(key);
  }

  async run(key: string, command: Record<string, unknown> & { type: string }, okText?: (r: Result) => string): Promise<Result> {
    const token = this.session.token(), serverId = this.live.hello()?.serverId;
    this.busy.update((s) => new Set(s).add(key));
    try {
      const r = await this.live.command(command);
      if (token === this.session.token() && serverId === this.live.hello()?.serverId) { this.receipt.set({ receivedAt: Date.now(), result: r }); this.report(r, okText); }
      return r;
    } finally {
      this.busy.update((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  async decide(pendingId: string, approve: boolean): Promise<void> {
    const token = this.session.token(), serverId = this.live.hello()?.serverId;
    this.deciding.set(pendingId);
    try {
      const r = approve ? await this.live.approve(pendingId) : await this.live.reject(pendingId);
      if (token !== this.session.token() || serverId !== this.live.hello()?.serverId) return;
      this.receipt.set({ receivedAt: Date.now(), result: r });
      if (!r.ok) this.live.toast('error', r.message);
    } finally {
      this.deciding.set(null);
    }
  }

  /** Gesto de fader: um id por arraste (do toque até soltar). */
  private gestures = new Map<string, string>();
  fader(target: string, channel: number, aux: number | undefined, db: number, final: boolean): void {
    let id = this.gestures.get(target);
    if (!id) {
      id = newId('g');
      this.gestures.set(target, id);
    }
    this.live.fader(id, channel, aux, db, final);
    if (final) this.gestures.delete(target);
  }

  private report(r: Result, okText?: (r: Result) => string) {
    if (r.needsConfirmation || r.code === 'NEEDS_CONFIRMATION') {
      this.live.toast('info', 'Precisa de aprovação: confira o cartão de confirmação.');
    } else if (!r.ok) {
      this.live.toast('error', r.message);
    } else if (okText) {
      this.live.toast('ok', okText(r));
    }
  }
}

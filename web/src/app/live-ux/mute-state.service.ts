import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';

/** Espelho do contrato de GET /api/ui16/mute-state (somente leitura). */
export type MuteCause =
  | 'none' | 'individual' | 'mute_all' | 'individual_and_mute_all' | 'force_unmute_precedence_pending'
  | 'other_mute_group_membership_unvalidated' | 'group_state_unavailable' | 'individual_unavailable' | 'force_unmute_unavailable';
export interface ChannelMuteState {
  channel: number;
  individual: boolean | null;
  muteAll: 'active' | 'inactive' | 'unknown';
  otherGroupsActive: boolean | null;
  forceUnmute: boolean | null;
  effective: 'muted' | 'open' | 'unknown';
  cause: MuteCause;
  precedence: 'not_needed' | 'pending';
  reasons: string[];
}
export interface MuteStateView {
  serverId: string;
  groups: { state: 'confirmed' | 'unknown'; mask: number | null; muteAll: 'active' | 'inactive' | 'unknown'; otherGroupsActive: boolean | null; reason?: string };
  channels: ChannelMuteState[];
}

/** Texto curto (e explicação) do MUTE efetivo. Nunca chama de "aberto" o que a mesa não confirmou. */
export function muteLabel(s: ChannelMuteState): { text: string; title: string; tone: 'muted' | 'open' | 'unknown' } {
  switch (s.cause) {
    case 'none': return { text: 'ABERTO', title: 'Nenhum MUTE individual nem grupo ativo silencia este canal.', tone: 'open' };
    case 'individual': return { text: 'MUDO · individual', title: 'Silenciado pelo MUTE do próprio canal.', tone: 'muted' };
    case 'mute_all': return { text: 'MUDO · Mute All', title: 'O MUTE individual está aberto, mas o Mute All da mesa silencia este canal (sem Force Unmute).', tone: 'muted' };
    case 'individual_and_mute_all': return { text: 'MUDO · indiv. + Mute All', title: 'Silenciado pelo MUTE do canal e também pelo Mute All.', tone: 'muted' };
    case 'force_unmute_precedence_pending': return { text: 'FORCE UNMUTE · efetivo ?', title: 'Force Unmute ligado com Mute All ou MUTE individual: a precedência do firmware ainda não foi validada na mesa física, então o estado efetivo não é afirmado.', tone: 'unknown' };
    case 'other_mute_group_membership_unvalidated': return { text: 'GRUPO DE MUTE · efetivo ?', title: 'Há um grupo de mute (1–6/FX) ativo e a pertinência do canal ainda não foi validada.', tone: 'unknown' };
    case 'force_unmute_unavailable': return { text: 'Force Unmute ?', title: 'O Force Unmute deste canal não foi observado nesta conexão; o estado efetivo não é afirmado.', tone: 'unknown' };
    case 'group_state_unavailable': return { text: 'GRUPOS ? · efetivo ?', title: 'O estado dos grupos de mute (Mute All) não foi observado nesta conexão; o estado efetivo não é afirmado.', tone: 'unknown' };
    default: return { text: 'MUTE ?', title: 'O MUTE individual não está disponível agora; o estado efetivo não é afirmado.', tone: 'unknown' };
  }
}

/**
 * Observação do MUTE efetivo (REAL, somente leitura). Consulta o servidor a cada 2 s; nenhuma escrita, nenhum comando.
 * Troca de sessão/instância/modo/conexão descarta o estado e respostas atrasadas; falha de rede = desconhecido (nunca "aberto").
 */
@Injectable({ providedIn: 'root' })
export class MuteStateService {
  private readonly live = inject(LiveService);
  private readonly session = inject(SessionService);
  readonly view = signal<MuteStateView | null>(null);
  readonly eligible = computed(() => this.live.hello()?.mode === 'real' && this.session.role() === 'operator' && this.live.connection() === 'online' && !!this.session.token());
  readonly byChannel = computed(() => Object.fromEntries((this.view()?.channels ?? []).map((c) => [c.channel, c])) as Record<number, ChannelMuteState | undefined>);
  constructor() {
    effect((onCleanup) => {
      const hello = this.live.hello(), token = this.session.token(), eligible = this.eligible();
      this.view.set(null);
      if (!eligible || !hello || !token) return;
      let disposed = false, busy = false;
      let controller: AbortController | undefined;
      const poll = async () => {
        if (busy || disposed) return;
        busy = true;
        controller = new AbortController();
        const timer = setTimeout(() => controller?.abort(), 6000);
        try {
          const res = await fetch('/api/ui16/mute-state', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', signal: controller.signal });
          const body = res.ok ? ((await res.json()) as MuteStateView & { serverId?: string }) : null;
          if (!disposed) this.view.set(body && body.serverId === hello.serverId && Array.isArray(body.channels) && body.groups ? body : null);
        } catch { if (!disposed) this.view.set(null); }
        finally { clearTimeout(timer); busy = false; }
      };
      void poll();
      const interval = setInterval(() => void poll(), 2000);
      onCleanup(() => { disposed = true; controller?.abort(); clearInterval(interval); });
    });
    inject(DestroyRef).onDestroy(() => this.view.set(null));
  }
}

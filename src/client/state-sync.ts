import {
  applyStateEvent,
  eventFromWire,
  snapshotFromWire,
  type MixerStateSnapshot,
  type WireEvent,
  type WireSnapshot,
} from '../core/state.js';

/**
 * Cliente de referência do protocolo de estado (a interface da E3 faz o mesmo).
 * Regras:
 * - só aplica eventos depois de ter um snapshot do MESMO serverId;
 * - outro serverId (servidor reiniciou) = descarta tudo e espera snapshot novo;
 * - buraco na sequência de revisões (evento perdido) ou leitura que voltou = pede snapshot.
 */
export type SyncOutcome = 'ready' | 'applied' | 'stale' | 'resync' | 'ignored';

export class StateSync {
  serverId: string | undefined;
  state: MixerStateSnapshot | undefined;
  resyncRequests = 0;
  restarts = 0;

  constructor(private requestResync: () => void) {}

  handle(msg: { type?: unknown; serverId?: unknown; snapshot?: unknown; event?: unknown }): SyncOutcome {
    const serverId = typeof msg.serverId === 'string' ? msg.serverId : undefined;
    if (serverId && this.serverId && serverId !== this.serverId) {
      // Servidor reiniciado: revisões antigas não significam mais nada.
      this.restarts++;
      this.state = undefined;
    }
    if (serverId) this.serverId = serverId;
    if (msg.type === 'snapshot') {
      this.state = snapshotFromWire(msg.snapshot as WireSnapshot);
      return 'ready';
    }
    if (msg.type !== 'event') return 'ignored';
    if (!this.state) return this.resync();
    let outcome;
    try {
      outcome = applyStateEvent(this.state, eventFromWire(msg.event as WireEvent));
    } catch {
      return this.resync(); // evento ilegível: nunca adivinhar
    }
    return outcome === 'gap' ? this.resync() : outcome;
  }

  private resync(): SyncOutcome {
    this.resyncRequests++;
    this.requestResync();
    return 'resync';
  }
}

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LevelRequest, MuteRequest, Result } from '../core/controller.js';
import type { MixBackend } from './backend.js';

/**
 * Cliente HTTP do servidor único. É o que o MCP usa: não importa nada da mesa, do laboratório
 * nem do controlador. Se o servidor não estiver rodando, devolve SERVER_UNAVAILABLE e não faz
 * mais nada (nunca abre a mesa sozinho).
 */
export interface RemoteOptions {
  /** Ex.: http://127.0.0.1:8790 (sempre na própria máquina). */
  baseUrl: string;
  /** Modo esperado. O servidor recusa se estiver em outro modo (LAB nunca vira REAL). */
  mode: 'mock' | 'lab' | 'real';
  /** Arquivo com o token do assistente, gravado pelo servidor ao iniciar. */
  tokenFile: string;
  timeoutMs?: number;
  /** Para testes. */
  fetchImpl?: typeof fetch;
}

const START_HINT: Record<RemoteOptions['mode'], string> = {
  lab: 'npm run serve:lab',
  mock: 'npm run serve:mock',
  real: 'npm run serve:real',
};

export class RemoteBackend implements MixBackend {
  constructor(private opts: RemoteOptions) {}

  ensureConnected() {
    return this.call({ type: 'status' });
  }
  listNames() {
    return this.call({ type: 'list_names' });
  }
  mixState(aux?: string | number) {
    return this.call({ type: 'mix_state', aux: aux === '' ? undefined : aux });
  }
  setLevel(req: LevelRequest) {
    return this.call({ type: 'set_level', channel: req.channel, aux: req.aux === '' ? undefined : req.aux, db: req.db, deltaDB: req.deltaDB }, req.confirmationId);
  }
  setMute(req: MuteRequest) {
    return this.call({ type: 'set_mute', channels: req.channels, muted: req.muted, aux: req.aux === '' ? undefined : req.aux }, req.confirmationId);
  }
  setMaster(req: { db?: number; deltaDB?: number; confirmationId?: string }) {
    return this.call({ type: 'set_master', db: req.db, deltaDB: req.deltaDB }, req.confirmationId);
  }
  undo(steps = 1) {
    return this.call({ type: 'undo', steps });
  }
  history(limit = 20) {
    return this.call({ type: 'history', limit });
  }
  listSnapshots() {
    return this.call({ type: 'list_snapshots' });
  }
  loadSnapshot(req: { show: string; snapshot: string; confirmationId?: string }) {
    return this.call({ type: 'load_snapshot', show: req.show, snapshot: req.snapshot }, req.confirmationId);
  }

  private unavailable(detail: string): Result {
    return {
      ok: false,
      code: 'SERVER_UNAVAILABLE',
      message:
        `O servidor do MixAI (modo ${this.opts.mode.toUpperCase()}, ${this.opts.baseUrl}) não está disponível: ${detail}. ` +
        `Nada foi alterado e o assistente não controla a mesa sem ele. Peça para iniciar o servidor no notebook ("${START_HINT[this.opts.mode]}").`,
    };
  }

  private token(): string | undefined {
    try {
      return readFileSync(this.opts.tokenFile, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Um requestId por chamada de tool. Se a resposta se perder (conexão caiu no meio), a mesma
   * chamada é repetida UMA vez com o MESMO requestId: o servidor não executa duas vezes.
   * Uma tentativa de confirmação (confirmationId) é enviada como está: o servidor recusa.
   */
  private async call(command: Record<string, unknown>, confirmationId?: string): Promise<Result> {
    const requestId = randomUUID();
    const body = {
      requestId,
      targetMode: this.opts.mode,
      command: confirmationId ? { ...clean(command), confirmationId } : clean(command),
    };
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.token();
      if (!token) return this.unavailable('o servidor não está rodando (token local não encontrado)');
      try {
        const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}/api/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
        const json = (await res.json().catch(() => undefined)) as { result?: Result } | undefined;
        if (res.status === 401 && attempt === 0) continue; // servidor reiniciado: relê o token
        if (json?.result) return json.result;
        return this.unavailable(`resposta inesperada (HTTP ${res.status})`);
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        if (e.cause?.code === 'ECONNREFUSED') return this.unavailable('o servidor não está rodando');
        lastError = e.name === 'TimeoutError' ? 'sem resposta a tempo' : (e.cause?.code ?? e.message);
      }
    }
    return this.unavailable(lastError || 'sessão recusada');
  }
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

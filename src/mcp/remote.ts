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

  /** Certeza de que NADA foi executado (o pedido não chegou a nenhum servidor). */
  private unavailable(detail: string): Result {
    return {
      ok: false,
      code: 'SERVER_UNAVAILABLE',
      message:
        `O servidor do MixAI (modo ${this.opts.mode.toUpperCase()}, ${this.opts.baseUrl}) não está disponível: ${detail}. ` +
        `Nada foi alterado e o assistente não controla a mesa sem ele. Peça para iniciar o servidor no notebook ("${START_HINT[this.opts.mode]}").`,
    };
  }

  /** O pedido pode ter sido executado e não há como saber: NUNCA dizer "nada foi alterado". */
  private indeterminate(detail: string): Result {
    return {
      ok: false,
      code: 'INDETERMINATE',
      message:
        `RESULTADO INDETERMINADO: o pedido chegou ao servidor, mas a resposta se perdeu (${detail}). ` +
        'A alteração PODE ter sido aplicada. Não repita o comando: confira primeiro com get_mix_state ou get_action_log.',
    };
  }

  private token(): string | undefined {
    try {
      return readFileSync(this.opts.tokenFile, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private fetch(path: string, init: RequestInit = {}) {
    return (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
  }

  /** serverId da instância que está rodando agora (sem autenticação). */
  private async serverId(): Promise<{ id: string } | { error: string; refused: boolean }> {
    try {
      const res = await this.fetch('/api/hello');
      const json = (await res.json()) as { serverId?: unknown };
      return typeof json.serverId === 'string' ? { id: json.serverId } : { error: 'resposta sem serverId', refused: false };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      return { error: e.cause?.code ?? e.message, refused: e.cause?.code === 'ECONNREFUSED' };
    }
  }

  /**
   * Cada chamada de tool tem um requestId e fica PRESA a uma instância do servidor (serverId).
   * - Resposta perdida (queda, timeout): repete com o MESMO requestId na MESMA instância; o
   *   servidor devolve a resposta guardada em vez de executar de novo.
   * - Se a instância mudou (reinício) depois de um envio que pode ter sido executado, NÃO repete:
   *   devolve INDETERMINATE. Uma escrita nunca é repetida numa instância nova.
   * - Recusas que provam que nada foi executado (401, SERVER_CHANGED antes de qualquer envio
   *   incerto) podem ser refeitas com segurança na instância nova.
   * Uma tentativa de confirmação (confirmationId) é enviada como está: o servidor recusa.
   */
  private async call(command: Record<string, unknown>, confirmationId?: string): Promise<Result> {
    const requestId = randomUUID();
    const isWrite = WRITE_TYPES.has(String(command.type));
    let maybeExecuted = false;
    let pinned: string | undefined;
    let lastError = '';
    const lost = (why: string) => (maybeExecuted ? this.indeterminate(why) : this.unavailable(why));

    for (let attempt = 0; attempt < 3; attempt++) {
      const token = this.token();
      if (!token) return lost('o servidor não está rodando (token local não encontrado)');
      if (!pinned) {
        const hello = await this.serverId();
        if ('error' in hello) return lost(hello.refused ? 'o servidor não está rodando' : `sem resposta (${hello.error})`);
        pinned = hello.id;
      }
      const body = {
        requestId,
        serverId: pinned,
        targetMode: this.opts.mode,
        command: confirmationId ? { ...clean(command), confirmationId } : clean(command),
      };
      let res: Response;
      let json: { result?: Result } | undefined;
      try {
        res = await this.fetch('/api/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        json = (await res.json().catch(() => undefined)) as { result?: Result } | undefined;
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        if (e.cause?.code === 'ECONNREFUSED') return lost('o servidor não está rodando'); // este envio não chegou
        lastError = e.name === 'TimeoutError' ? 'sem resposta a tempo' : (e.cause?.code ?? e.message);
        if (isWrite) maybeExecuted = true; // pode ter chegado e sido executado
        continue; // mesma instância, mesmo requestId: o servidor não executa de novo
      }
      if (res.status === 401 || json?.result?.code === 'SERVER_CHANGED') {
        // Esta tentativa foi recusada sem executar. Se uma anterior pode ter executado na
        // instância antiga, não há como conferir: indeterminado.
        if (maybeExecuted) return this.indeterminate(`${lastError || 'resposta perdida'}; o servidor reiniciou em seguida`);
        pinned = undefined; // instância nova: relê token e serverId
        continue;
      }
      if (json?.result) return json.result;
      lastError = `resposta inesperada (HTTP ${res.status})`;
      if (isWrite) maybeExecuted = true;
    }
    return lost(lastError || 'sessão recusada');
  }
}

/** Comandos que mudam a mesa: nunca repetidos às cegas. */
const WRITE_TYPES = new Set(['set_level', 'set_mute', 'set_master', 'undo', 'load_snapshot']);

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

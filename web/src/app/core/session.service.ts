import { Injectable, signal } from '@angular/core';
import type { Hello, Role } from './protocol';

const TOKEN = 'mixai.token';
const ROLE = 'mixai.role';
const SERVER = 'mixai.serverId';

/** sessionStorage pode falhar (aba privada, bloqueio): a tela funciona sem ele. */
function store(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Sessão aberta com PIN. O token fica só nesta aba (sessionStorage) e nunca vai na URL.
 * A tela só esconde botões conforme o perfil; quem decide é sempre o servidor.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  readonly token = signal<string | null>(null);
  readonly role = signal<Role | null>(null);
  /** Mensagem mostrada na tela de PIN (sessão vencida, servidor reiniciado...). */
  readonly notice = signal<string | null>(null);
  /** Instância do servidor em que esta sessão foi aberta (para reconhecer um reinício). */
  serverId: string | null = null;

  constructor() {
    try {
      const t = store()?.getItem(TOKEN);
      const r = store()?.getItem(ROLE) as Role | null | undefined;
      if (t && (r === 'operator' || r === 'musician')) {
        this.token.set(t);
        this.role.set(r);
        this.serverId = store()?.getItem(SERVER) ?? null;
      }
    } catch {
      /* sem armazenamento: precisa entrar com PIN a cada recarga */
    }
  }

  async hello(): Promise<Hello | null> {
    try {
      const res = await fetch('/api/hello');
      return res.ok ? ((await res.json()) as Hello) : null;
    } catch {
      return null;
    }
  }

  /** Devolve null se deu certo, ou a mensagem de erro para mostrar. */
  async login(pin: string): Promise<string | null> {
    let res: Response;
    try {
      res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
    } catch {
      return 'Servidor do MixAI indisponível. Confira a rede e se o servidor está ligado.';
    }
    const body = (await res.json().catch(() => ({}))) as { token?: string; role?: Role; result?: { message?: string } };
    if (!res.ok || !body.token || (body.role !== 'operator' && body.role !== 'musician')) {
      return body.result?.message ?? 'Não foi possível entrar.';
    }
    this.serverId = null;
    this.token.set(body.token);
    this.role.set(body.role);
    this.notice.set(null);
    try {
      store()?.setItem(TOKEN, body.token);
      store()?.setItem(ROLE, body.role);
    } catch {
      /* ignora */
    }
    return null;
  }

  async logout(): Promise<void> {
    const t = this.token();
    this.clear();
    if (t) await fetch('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  }

  /** Guarda a instância do servidor vista no hello desta sessão. */
  rememberServer(id: string): void {
    this.serverId = id;
    try {
      store()?.setItem(SERVER, id);
    } catch {
      /* ignora */
    }
  }

  /** O servidor recusou a sessão (vencida, logout em outro lugar, servidor reiniciado). */
  expire(message: string): void {
    this.clear();
    this.notice.set(message);
  }

  private clear() {
    this.token.set(null);
    this.role.set(null);
    this.serverId = null;
    try {
      store()?.removeItem(TOKEN);
      store()?.removeItem(ROLE);
      store()?.removeItem(SERVER);
    } catch {
      /* ignora */
    }
  }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isValidPinHash, verifyPin } from './pin.js';

/**
 * Perfis:
 * - operator: PA, master, AUX 1, aprova operações críticas, histórico, reset do laboratório;
 * - musician: consulta o retorno e ajusta SÓ o AUX 1 (fones); não aprova nada;
 * - agent: o assistente (MCP). Propõe e executa comandos comuns, mas NUNCA aprova.
 */
export type Role = 'operator' | 'musician' | 'agent';

export interface Principal {
  /** Identificador da sessão (não é o token). */
  id: string;
  role: Role;
  label: string;
}

export type LoginResult =
  | { ok: true; token: string; principal: Principal; expiresAt: number }
  | { ok: false; code: 'UNAUTHORIZED' | 'RATE_LIMIT' | 'NOT_CONFIGURED'; message: string; retryAfterSec?: number };

interface Session {
  principal: Principal;
  expiresAt: number;
}

/** Por que uma sessão deixou de valer: venceu (12 h) ou saiu (Sair). */
export type RevokeReason = 'expired' | 'logout';

interface Throttle {
  failures: number;
  lockedUntil: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export const isLoopback = (ip: string | undefined) =>
  !!ip && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.'));

export interface AuthOptions {
  operatorPinHash?: string;
  musicianPinHash?: string;
  /** Token do assistente (gerado a cada início do servidor; só vale vindo de 127.0.0.1). */
  agentToken: string;
  sessionTtlMs?: number;
  clock?: () => number;
  /** Tentativas erradas por endereço antes de bloquear. */
  maxFailures?: number;
  /** Bloqueio inicial; dobra a cada novo erro, até 15 min. */
  lockMs?: number;
  /** Erros somados de todos os endereços, por minuto, antes do bloqueio geral. */
  globalMaxFailuresPerMinute?: number;
}

/**
 * Autenticação simples por PIN, com perfis separados e verificação no servidor.
 * - PINs só existem como hash (scrypt); tokens de sessão só como SHA-256 em memória;
 * - nada disso é registrado em log;
 * - reiniciar o servidor invalida todas as sessões (ficam só na memória).
 */
export class Auth {
  private sessions = new Map<string, Session>();
  private throttles = new Map<string, Throttle>();
  private globalFailures: number[] = [];
  private globalLockedUntil = 0;
  private revokeListeners = new Set<(principalId: string, reason: RevokeReason) => void>();
  private readonly agentHash: Buffer;
  private readonly clock: () => number;
  private readonly ttl: number;
  private readonly operatorHash?: string;
  private readonly musicianHash?: string;

  constructor(private opts: AuthOptions) {
    this.clock = opts.clock ?? Date.now;
    this.ttl = opts.sessionTtlMs ?? 12 * 3_600_000;
    this.agentHash = sha256(opts.agentToken);
    this.operatorHash = isValidPinHash(opts.operatorPinHash) ? opts.operatorPinHash : undefined;
    this.musicianHash = isValidPinHash(opts.musicianPinHash) ? opts.musicianPinHash : undefined;
  }

  configured(): { operator: boolean; musician: boolean } {
    return { operator: !!this.operatorHash, musician: !!this.musicianHash };
  }

  login(pin: unknown, ip: string): LoginResult {
    const now = this.clock();
    if (!this.operatorHash && !this.musicianHash) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'Nenhum PIN configurado no servidor. Rode "npm run pin" no notebook.' };
    }
    if (now < this.globalLockedUntil) {
      return this.blocked(this.globalLockedUntil - now, 'Muitas tentativas erradas na rede.');
    }
    if (this.throttles.size > 1000) {
      for (const [k, v] of this.throttles) if (v.lockedUntil < now) this.throttles.delete(k);
    }
    const t = this.throttles.get(ip) ?? { failures: 0, lockedUntil: 0 };
    if (now < t.lockedUntil) return this.blocked(t.lockedUntil - now, 'Muitas tentativas erradas deste aparelho.');

    const text = typeof pin === 'string' ? pin.trim() : '';
    // Os dois hashes são sempre conferidos, para o tempo de resposta não revelar o perfil.
    const isOperator = verifyPin(text, this.operatorHash);
    const isMusician = verifyPin(text, this.musicianHash);
    const role: Role | undefined = isOperator ? 'operator' : isMusician ? 'musician' : undefined;
    if (!role) {
      t.failures++;
      const max = this.opts.maxFailures ?? 5;
      if (t.failures >= max) {
        const lock = Math.min((this.opts.lockMs ?? 30_000) * 2 ** (t.failures - max), 15 * 60_000);
        t.lockedUntil = now + lock;
      }
      this.throttles.set(ip, t);
      this.globalFailures = this.globalFailures.filter((x) => now - x < 60_000);
      this.globalFailures.push(now);
      if (this.globalFailures.length >= (this.opts.globalMaxFailuresPerMinute ?? 30)) this.globalLockedUntil = now + 60_000;
      return { ok: false, code: 'UNAUTHORIZED', message: 'PIN incorreto.' };
    }
    this.throttles.delete(ip);
    const token = randomBytes(32).toString('base64url');
    const principal: Principal = {
      id: randomBytes(8).toString('hex'),
      role,
      label: role === 'operator' ? 'operador' : 'músico',
    };
    const expiresAt = now + this.ttl;
    this.sessions.set(sha256(token).toString('hex'), { principal, expiresAt });
    return { ok: true, token, principal, expiresAt };
  }

  /** Sessão humana (PIN) ou o assistente (token local). undefined = não autenticado. */
  authenticate(token: unknown, ip: string | undefined): Principal | undefined {
    if (typeof token !== 'string' || !token || token.length > 200) return undefined;
    const h = sha256(token);
    if (timingSafeEqual(h, this.agentHash)) {
      // O token do assistente só vale na própria máquina.
      return isLoopback(ip) ? { id: 'agent', role: 'agent', label: 'assistente (MCP)' } : undefined;
    }
    const key = h.toString('hex');
    const s = this.sessions.get(key);
    if (!s) return undefined;
    if (this.clock() > s.expiresAt) {
      this.sessions.delete(key);
      return undefined;
    }
    return s.principal;
  }

  /**
   * A sessão ainda vale? Conferido pelo WebSocket antes de CADA envio e periodicamente,
   * para derrubar conexões de sessões encerradas ou vencidas mesmo que estejam ociosas.
   */
  isActive(principal: Principal): boolean {
    if (principal.role === 'agent') return true;
    const now = this.clock();
    for (const [key, s] of this.sessions) {
      if (s.principal.id !== principal.id) continue;
      if (now <= s.expiresAt) return true;
      this.sessions.delete(key);
      this.emitRevoke(principal.id, 'expired');
      return false;
    }
    return false;
  }

  logout(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const key = sha256(token).toString('hex');
    const s = this.sessions.get(key);
    if (!s) return false;
    this.sessions.delete(key);
    this.emitRevoke(s.principal.id, 'logout');
    return true;
  }

  /** Avisa quando uma sessão é encerrada (logout) ou vence. */
  onRevoke(listener: (principalId: string, reason: RevokeReason) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private emitRevoke(id: string, reason: RevokeReason) {
    for (const l of this.revokeListeners) {
      try {
        l(id, reason);
      } catch {
        /* ignora */
      }
    }
  }

  private blocked(ms: number, why: string): LoginResult {
    const retryAfterSec = Math.ceil(ms / 1000);
    return { ok: false, code: 'RATE_LIMIT', message: `${why} Tente de novo em ${retryAfterSec} s.`, retryAfterSec };
  }
}

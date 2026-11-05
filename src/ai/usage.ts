import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DailyUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export type ReserveResult = { ok: true; id: string; reservedUSD: number } | { ok: false; reason: 'budget' | 'blocked'; message: string };

/**
 * Consumo da IA por dia (data/ai-usage.json, fora do Git) com RESERVA de orçamento:
 *
 * - antes de cada chamada, o custo MÁXIMO estimado é reservado; reservas em andamento contam
 *   para o teto (duas sessões perto do limite não passam juntas);
 * - ao terminar, a reserva é trocada pelo custo real informado pela API (usage);
 * - falha em que a API PODE ter processado (tempo esgotado, rede caiu, erro 5xx, resposta sem
 *   consumo) → cobra a estimativa inteira (conservador); recusa clara sem processamento
 *   (400/401/403/404/413/429) → libera a reserva;
 * - arquivo de consumo ilegível → guarda como .corrupt-<data> e BLOQUEIA a IA até o dia virar
 *   (não dá para saber quanto já foi gasto hoje).
 *
 * É uma proteção por ESTIMATIVA (preços configurados × tokens), não garantia de faturamento.
 */
export class UsageTracker {
  private today: DailyUsage;
  private reservations = new Map<string, number>();
  private blockedDay: string | undefined;
  private recent: number[] = [];
  private seq = 0;

  constructor(
    private file: string | null,
    private clock: () => number = Date.now,
  ) {
    this.today = this.load();
  }

  private day(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  private empty(): DailyUsage {
    return { day: this.day(), requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
  }

  private load(): DailyUsage {
    if (!this.file || !existsSync(this.file)) return this.empty();
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DailyUsage>;
      const valid =
        typeof v.day === 'string' &&
        [v.requests, v.inputTokens, v.outputTokens, v.costUSD].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
      if (!valid) throw new Error('formato inválido');
      return v.day === this.day() ? (v as DailyUsage) : this.empty();
    } catch {
      // Não sabemos quanto já foi gasto hoje: bloqueia a IA até o dia virar.
      this.blockedDay = this.day();
      try {
        renameSync(this.file, `${this.file}.corrupt-${new Date(this.clock()).toISOString().replace(/[:.]/g, '-')}`);
      } catch {
        /* se nem renomear der, segue bloqueado */
      }
      return this.empty();
    }
  }

  /** Consumo registrado hoje (sem as reservas em andamento). */
  current(): DailyUsage & { reservedUSD: number; blocked: boolean } {
    if (this.today.day !== this.day()) this.today = this.empty();
    return { ...this.today, reservedUSD: this.reserved(), blocked: this.isBlocked() };
  }

  private reserved(): number {
    let sum = 0;
    for (const v of this.reservations.values()) sum += v;
    return sum;
  }

  private isBlocked(): boolean {
    if (this.blockedDay && this.blockedDay !== this.day()) this.blockedDay = undefined;
    return !!this.blockedDay;
  }

  /** Reserva o custo máximo estimado. Gasto registrado + reservas + este ≤ teto. */
  reserve(maxCostUSD: number, budgetUSD: number): ReserveResult {
    if (this.isBlocked()) {
      return {
        ok: false,
        reason: 'blocked',
        message: 'O registro de consumo da IA estava ilegível; por segurança a IA fica desligada até amanhã. Comandos diretos continuam funcionando.',
      };
    }
    const u = this.current();
    if (u.costUSD + u.reservedUSD + maxCostUSD > budgetUSD + 1e-12) {
      return { ok: false, reason: 'budget', message: `O limite diário de gasto com IA (US$ ${budgetUSD.toFixed(2)}) foi atingido. Comandos diretos continuam funcionando.` };
    }
    const id = `r${++this.seq}`;
    this.reservations.set(id, maxCostUSD);
    return { ok: true, id, reservedUSD: maxCostUSD };
  }

  /** Troca a reserva pelo consumo real informado pela API. */
  settle(id: string, inputTokens: number, outputTokens: number, costUSD: number): void {
    this.reservations.delete(id);
    this.record(inputTokens, outputTokens, costUSD);
  }

  /** A API pode ter processado e não sabemos quanto: cobra a reserva inteira. */
  chargeReserved(id: string): number {
    const amount = this.reservations.get(id) ?? 0;
    this.reservations.delete(id);
    this.record(0, 0, amount);
    return amount;
  }

  /** Recusa clara, sem processamento: libera a reserva sem cobrar. */
  release(id: string): void {
    this.reservations.delete(id);
  }

  /** Limite de pedidos por minuto (todos os usuários juntos). */
  takeSlot(perMinute: number): boolean {
    const now = this.clock();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= perMinute) return false;
    this.recent.push(now);
    return true;
  }

  private record(inputTokens: number, outputTokens: number, costUSD: number): void {
    const u = this.current();
    this.today = {
      day: u.day,
      requests: u.requests + 1,
      inputTokens: u.inputTokens + inputTokens,
      outputTokens: u.outputTokens + outputTokens,
      costUSD: Math.round((u.costUSD + costUSD) * 1e9) / 1e9,
    };
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.today));
        renameSync(`${this.file}.tmp`, this.file);
      } catch {
        /* falha ao gravar não derruba nada: o teto continua valendo em memória */
      }
    }
  }
}

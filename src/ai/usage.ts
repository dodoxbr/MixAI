import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DailyUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

/**
 * Consumo da IA por dia (gravado em data/ai-usage.json, fora do Git), para o teto diário de
 * gasto valer mesmo depois de reiniciar o servidor. Também limita pedidos por minuto.
 */
export class UsageTracker {
  private today: DailyUsage;
  private recent: number[] = [];

  constructor(
    private file: string | null,
    private clock: () => number = Date.now,
  ) {
    this.today = this.load();
  }

  private day(): string {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  private load(): DailyUsage {
    const empty = { day: this.day(), requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    if (!this.file) return empty;
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as DailyUsage;
      return v.day === empty.day && typeof v.costUSD === 'number' ? v : empty;
    } catch {
      return empty;
    }
  }

  current(): DailyUsage {
    if (this.today.day !== this.day()) this.today = { day: this.day(), requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    return { ...this.today };
  }

  /** Cabe mais um pedido com este custo máximo estimado? */
  canSpend(maxCostUSD: number, budgetUSD: number): boolean {
    return this.current().costUSD + maxCostUSD <= budgetUSD + 1e-9;
  }

  /** Limite de pedidos por minuto (todos os usuários juntos). */
  takeSlot(perMinute: number): boolean {
    const now = this.clock();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= perMinute) return false;
    this.recent.push(now);
    return true;
  }

  record(inputTokens: number, outputTokens: number, costUSD: number): DailyUsage {
    const u = this.current();
    this.today = {
      day: u.day,
      requests: u.requests + 1,
      inputTokens: u.inputTokens + inputTokens,
      outputTokens: u.outputTokens + outputTokens,
      costUSD: Math.round((u.costUSD + costUSD) * 1e6) / 1e6,
    };
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.today));
        renameSync(`${this.file}.tmp`, this.file);
      } catch {
        /* falha ao gravar o consumo não derruba nada (o teto continua valendo em memória) */
      }
    }
    return { ...this.today };
  }
}

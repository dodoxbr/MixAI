import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DailyUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export type ReserveResult =
  | { ok: true; id: string; reservedUSD: number }
  | { ok: false; reason: 'budget' | 'blocked' | 'persist'; message: string };

const MSG_BLOCKED = 'O registro de consumo da IA estava ilegível; por segurança a IA fica desligada até amanhã. Comandos diretos continuam funcionando.';
const MSG_PERSIST =
  'Não foi possível gravar o registro de consumo da IA; por segurança a IA fica pausada até a gravação voltar a funcionar. Comandos diretos continuam funcionando.';

/**
 * Consumo da IA por dia (data/ai-usage.json, fora do Git) com RESERVA de orçamento:
 *
 * - antes de cada chamada, o custo MÁXIMO estimado é reservado e a reserva é GRAVADA no
 *   arquivo; reservas em andamento contam para o teto (duas sessões perto do limite não
 *   passam juntas). Se o servidor cair no meio da chamada, a reserva gravada é cobrada ao
 *   reiniciar (conservador);
 * - ao terminar, a reserva é trocada pelo custo real informado pela API (usage);
 * - falha em que a API PODE ter processado (tempo esgotado, rede caiu, erro 5xx, resposta sem
 *   consumo) → cobra a estimativa inteira (conservador); recusa clara sem processamento
 *   (400/401/403/404/413/429) → libera a reserva;
 * - não deu para GRAVAR o consumo → a IA fica pausada (nenhuma chamada nova) até uma gravação
 *   dar certo; a cada pedido tenta gravar de novo;
 * - arquivo de consumo ilegível → BLOQUEIA a IA até o dia virar (não dá para saber quanto já
 *   foi gasto hoje). O bloqueio é gravado em ai-usage.json.blocked (vale depois de reiniciar)
 *   e só então o arquivo ilegível é tirado do caminho, como ai-usage.json.corrupt-<data>
 *   (nunca sobrescrito). Se nem o bloqueio der para gravar, o arquivo ilegível fica onde está
 *   e é detectado de novo a cada início.
 *
 * É uma proteção por ESTIMATIVA (preços configurados × tokens), não garantia de faturamento.
 */
export class UsageTracker {
  private today: DailyUsage;
  private reservations = new Map<string, number>();
  private blockedDay: string | undefined;
  /** Última gravação falhou: nenhuma chamada nova até gravar de novo. */
  private persistFailed = false;
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

  private stamp(): string {
    return new Date(this.clock()).toISOString().replace(/[:.]/g, '-');
  }

  private empty(): DailyUsage {
    return { day: this.day(), requests: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
  }

  private get markerFile(): string {
    return `${this.file}.blocked`;
  }

  private load(): DailyUsage {
    if (!this.file) return this.empty();
    if (this.markerDay() === this.day()) this.blockedDay = this.day();
    if (!existsSync(this.file)) return this.empty();
    let v: Partial<DailyUsage> & { reservedUSD?: unknown };
    try {
      v = JSON.parse(readFileSync(this.file, 'utf8'));
      const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      const valid =
        !!v &&
        typeof v.day === 'string' &&
        [v.requests, v.inputTokens, v.outputTokens, v.costUSD].every(num) &&
        (v.reservedUSD === undefined || num(v.reservedUSD));
      if (!valid) throw new Error('formato inválido');
    } catch {
      this.quarantine();
      return this.empty();
    }
    if (v.day !== this.day()) return this.empty();
    // Reservas que estavam em andamento quando o servidor parou: cobra (a API pode ter processado).
    const inFlight = typeof v.reservedUSD === 'number' ? v.reservedUSD : 0;
    return {
      day: v.day,
      requests: v.requests!,
      inputTokens: v.inputTokens!,
      outputTokens: v.outputTokens!,
      costUSD: Math.round((v.costUSD! + inFlight) * 1e9) / 1e9,
    };
  }

  /** Dia do bloqueio gravado; marcador ilegível → dia em que foi gravado (data do arquivo). */
  private markerDay(): string | undefined {
    if (!existsSync(this.markerFile)) return undefined;
    try {
      const m = JSON.parse(readFileSync(this.markerFile, 'utf8')) as { day?: unknown };
      if (typeof m?.day === 'string') return m.day;
    } catch {
      /* cai para a data do arquivo */
    }
    try {
      return statSync(this.markerFile).mtime.toISOString().slice(0, 10);
    } catch {
      return this.day(); // nem isso: na dúvida, bloqueado hoje
    }
  }

  /**
   * Arquivo ilegível: bloqueia hoje. Primeiro GRAVA o bloqueio; só depois tira o arquivo
   * ilegível do caminho (com nome novo, sem sobrescrever nada). Se o bloqueio não puder ser
   * gravado, o arquivo ilegível fica onde está: o próximo início detecta e bloqueia de novo.
   */
  private quarantine(): void {
    const file = this.file!;
    this.blockedDay = this.day();
    const marker = { day: this.day(), reason: 'registro de consumo ilegível', since: new Date(this.clock()).toISOString() };
    if (!this.writeAtomic(this.markerFile, marker)) return;
    const base = `${file}.corrupt-${this.stamp()}`;
    let target = base;
    for (let i = 1; existsSync(target); i++) target = `${base}-${i}`;
    try {
      renameSync(file, target);
    } catch {
      /* fica no lugar; o bloqueio já está gravado */
    }
  }

  private writeAtomic(path: string, data: unknown): boolean {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(data));
      renameSync(`${path}.tmp`, path);
      return true;
    } catch {
      return false;
    }
  }

  /** Grava o consumo do dia + reservas em andamento. false = não gravou (IA fica pausada). */
  private persist(): boolean {
    if (!this.file) return true;
    const ok = this.writeAtomic(this.file, { ...this.today, reservedUSD: this.reserved() });
    this.persistFailed = !ok;
    return ok;
  }

  /** Consumo registrado hoje (sem as reservas em andamento). */
  current(): DailyUsage & { reservedUSD: number; blocked: boolean; paused: boolean } {
    if (this.today.day !== this.day()) this.today = this.empty();
    return { ...this.today, reservedUSD: this.reserved(), blocked: this.isBlocked(), paused: this.persistFailed };
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
    if (this.isBlocked()) return { ok: false, reason: 'blocked', message: MSG_BLOCKED };
    const u = this.current();
    // Gravação anterior falhou: só segue se conseguir gravar o que está em memória agora.
    if (this.persistFailed && !this.persist()) return { ok: false, reason: 'persist', message: MSG_PERSIST };
    if (u.costUSD + u.reservedUSD + maxCostUSD > budgetUSD + 1e-12) {
      return { ok: false, reason: 'budget', message: `O limite diário de gasto com IA (US$ ${budgetUSD.toFixed(2)}) foi atingido. Comandos diretos continuam funcionando.` };
    }
    const id = `r${++this.seq}`;
    this.reservations.set(id, maxCostUSD);
    // A reserva precisa estar gravada ANTES da chamada (vale se o servidor cair no meio).
    if (!this.persist()) {
      this.reservations.delete(id);
      return { ok: false, reason: 'persist', message: MSG_PERSIST };
    }
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
    this.persist();
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
    // Falhou ao gravar: o valor fica em memória e a IA pausa até a próxima gravação dar certo.
    this.persist();
  }
}

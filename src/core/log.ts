import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LogEntry {
  time: string;
  action: string;
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** Converte -Infinity em "-inf" para caber em JSON. */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? (v > 0 ? 'inf' : '-inf') : v)),
  );
}

/** Registro de tudo que foi feito na mesa: em memória e num arquivo .jsonl por dia. */
export class ActionLog {
  private entries: LogEntry[] = [];

  constructor(
    private dir: string | null,
    private now: () => Date = () => new Date(),
    private keep = 500,
  ) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  add(entry: Omit<LogEntry, 'time'>): LogEntry {
    const full: LogEntry = { time: this.now().toISOString(), ...entry };
    this.entries.push(full);
    if (this.entries.length > this.keep) this.entries.shift();
    if (this.dir) {
      try {
        const day = full.time.slice(0, 10);
        appendFileSync(join(this.dir, `acoes-${day}.jsonl`), JSON.stringify(jsonSafe(full)) + '\n');
      } catch (err) {
        // Log em disco nunca pode derrubar o controle da mesa.
        process.stderr.write(`[mixai] falha ao gravar log: ${(err as Error).message}\n`);
      }
    }
    return full;
  }

  recent(limit = 20): LogEntry[] {
    return this.entries.slice(-limit);
  }
}

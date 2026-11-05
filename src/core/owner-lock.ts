import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Outro processo do MixAI já é dono da mesa (ou do arquivo do laboratório). */
export class OwnerLockError extends Error {
  constructor(
    message: string,
    readonly holder?: { pid: number; role: string; since: string },
  ) {
    super(message);
    this.name = 'OwnerLockError';
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: o processo existe, mas é de outro usuário.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Trava de dono: garante UM processo dono da mesa física (e um só dono de cada arquivo de
 * laboratório). O servidor da E2 pega a trava ao iniciar; o console de testes também. Assim
 * nenhum outro processo abre uma segunda conexão com a Ui16.
 *
 * A trava é um arquivo criado de forma exclusiva com o pid do dono. Se o dono morreu sem apagar
 * (queda de energia, processo morto), a trava é considerada abandonada e reaproveitada.
 */
export class OwnerLock {
  private held = false;
  private readonly onExit = () => this.release();

  constructor(
    readonly file: string,
    private role: string,
  ) {}

  acquire(): this {
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(this.file, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, role: this.role, since: new Date().toISOString() }));
        closeSync(fd);
        this.held = true;
        process.once('exit', this.onExit);
        return this;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const holder = this.read();
      if (holder && holder.pid !== process.pid && alive(holder.pid)) {
        throw new OwnerLockError(
          `Outro processo do MixAI (${holder.role}, pid ${holder.pid}, desde ${holder.since}) já controla isto. ` +
            'Feche-o antes, ou use o servidor que já está rodando.',
          holder,
        );
      }
      if (holder && holder.pid === process.pid) {
        throw new OwnerLockError('Este processo já tem um dono para isto; não é permitido abrir uma segunda conexão.', holder);
      }
      // Abandonada (dono morto ou arquivo ilegível): apaga e tenta de novo.
      rmSync(this.file, { force: true });
    }
    throw new OwnerLockError(`Não consegui obter a trava ${this.file}.`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    process.removeListener('exit', this.onExit);
    const holder = this.read();
    if (holder?.pid === process.pid) rmSync(this.file, { force: true });
  }

  private read(): { pid: number; role: string; since: string } | undefined {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { pid?: unknown; role?: unknown; since?: unknown };
      return typeof v.pid === 'number' ? { pid: v.pid, role: String(v.role), since: String(v.since) } : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Arquivo da trava conforme o modo: um por mesa real, um por arquivo de laboratório. */
export function ownerLockFile(mode: 'mock' | 'lab' | 'real', labFile: string, dataDir: string): string | undefined {
  if (mode === 'real') return `${dataDir}/owner-real.lock`;
  if (mode === 'lab') return `${labFile}.lock`;
  return undefined; // mock: memória do próprio processo
}

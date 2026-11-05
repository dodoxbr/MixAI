import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Outro processo do MixAI já é dono da mesa (ou do arquivo do laboratório). */
export class OwnerLockError extends Error {
  constructor(
    message: string,
    readonly holder?: LockInfo,
  ) {
    super(message);
    this.name = 'OwnerLockError';
  }
}

export interface LockInfo {
  pid: number;
  role: string;
  since: string;
  /** Identifica esta aquisição (o pid sozinho pode ser reaproveitado). */
  nonce: string;
  host?: string;
  /** Pasta da instalação do MixAI que pegou a trava. */
  install?: string;
  /** Equipamento controlado (ex.: "ui16 em 10.10.1.1"). */
  equipment?: string;
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

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const ageMs = (file: string) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
};

/** Arquivo recém-criado e ainda vazio (o dono está escrevendo): espera antes de julgar. */
const FRESH_MS = 2000;
/** Depois da tomada de uma trava abandonada, confere se ninguém a sobrescreveu. */
const VERIFY_MS = 60;

/**
 * Trava de dono: garante UM processo dono da mesa física por computador (e um só dono de cada
 * arquivo de laboratório). O servidor pega a trava ao iniciar; o console de testes também.
 *
 * - A trava é um arquivo criado de forma EXCLUSIVA (`wx`) com o pid, a instalação e o
 *   equipamento. Criar é a única forma de ganhar a trava.
 * - Trava abandonada (dono morto): só é apagada por quem estiver com o "mutex de tomada"
 *   (outro arquivo exclusivo), depois de reler e confirmar que continua abandonada. Assim dois
 *   processos recuperando a mesma trava ao mesmo tempo não ganham os dois.
 * - Depois de uma tomada, o ganhador relê a trava após um instante e desiste se ela não for
 *   mais a sua (proteção extra caso o mutex de tomada também tenha sido abandonado).
 */
export class OwnerLock {
  private held = false;
  private readonly nonce = randomBytes(8).toString('hex');
  private readonly onExit = () => this.release();

  constructor(
    readonly file: string,
    private role: string,
    private details: { install?: string; equipment?: string } = {},
  ) {}

  acquire(timeoutMs = 3000): this {
    mkdirSync(dirname(this.file), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.create(this.file)) return this.won();
      const holder = this.read(this.file);
      if (holder) this.refuseIfHeld(holder);
      else if (ageMs(this.file) < FRESH_MS) {
        // Arquivo vazio e novo: outro processo acabou de criar e está escrevendo.
        this.waitOrFail(deadline);
        continue;
      }
      // Abandonada (dono morto ou arquivo ilegível antigo): tomada com exclusão mútua.
      const outcome = this.takeover();
      if (outcome === 'acquired') {
        sleepSync(VERIFY_MS);
        if (this.read(this.file)?.nonce === this.nonce) return this.won();
        this.held = false;
        const other = this.read(this.file);
        if (other) this.refuseIfHeld(other);
      }
      this.waitOrFail(deadline);
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    process.removeListener('exit', this.onExit);
    if (this.read(this.file)?.nonce === this.nonce) rmSync(this.file, { force: true });
  }

  // ---------- internos ----------

  private won(): this {
    this.held = true;
    process.once('exit', this.onExit);
    return this;
  }

  private refuseIfHeld(holder: LockInfo) {
    if (holder.pid === process.pid && holder.nonce !== this.nonce) {
      throw new OwnerLockError('Este processo já tem um dono para isto; não é permitido abrir uma segunda conexão.', holder);
    }
    if (alive(holder.pid)) {
      const where = holder.install ? `, instalação ${holder.install}` : '';
      const what = holder.equipment ? ` a ${holder.equipment}` : ' isto';
      throw new OwnerLockError(
        `Outro processo do MixAI (${holder.role}, pid ${holder.pid}${where}, desde ${holder.since}) já controla${what}. ` +
          'Feche-o antes, ou use o servidor que já está rodando.',
        holder,
      );
    }
  }

  private waitOrFail(deadline: number) {
    if (Date.now() > deadline) throw new OwnerLockError(`Não consegui obter a trava ${this.file} (outro processo disputando).`);
    sleepSync(10 + Math.floor(Math.random() * 20));
  }

  /** Cria o arquivo de forma exclusiva já com o conteúdo. false = já existe. */
  private create(file: string): boolean {
    let fd: number;
    try {
      fd = openSync(file, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    const info: LockInfo = {
      pid: process.pid,
      role: this.role,
      since: new Date().toISOString(),
      nonce: this.nonce,
      host: hostname(),
      ...this.details,
    };
    try {
      writeSync(fd, JSON.stringify(info));
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /** Tomada de trava abandonada, sob o mutex `<trava>.takeover`. */
  private takeover(): 'acquired' | 'busy' | 'held' {
    const mutex = `${this.file}.takeover`;
    if (!this.create(mutex)) {
      const m = this.read(mutex);
      // Mutex de tomada também abandonado (processo morreu dentro dele): limpa só se for velho.
      if ((!m || !alive(m.pid)) && ageMs(mutex) > 5000) rmSync(mutex, { force: true });
      return 'busy';
    }
    try {
      const again = this.read(this.file);
      if (again && alive(again.pid)) return 'held';
      if (!again && ageMs(this.file) < FRESH_MS && ageMs(this.file) !== Infinity) return 'busy';
      rmSync(this.file, { force: true });
      return this.create(this.file) ? 'acquired' : 'busy';
    } finally {
      if (this.read(mutex)?.nonce === this.nonce) rmSync(mutex, { force: true });
    }
  }

  private read(file: string): LockInfo | undefined {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
      return typeof v.pid === 'number' ? ({ ...v, nonce: String(v.nonce ?? ''), role: String(v.role), since: String(v.since) } as LockInfo) : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Pasta das travas, COMPARTILHADA por todas as instalações do MixAI no computador
 * (do usuário): ~/.mixai/locks. `MIXAI_LOCK_DIR` muda (testes).
 */
export function sharedLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIXAI_LOCK_DIR ? resolve(env.MIXAI_LOCK_DIR) : join(homedir(), '.mixai', 'locks');
}

/**
 * Arquivo da trava conforme o modo.
 * - real: UMA trava por computador, na pasta compartilhada, independente da pasta da instalação
 *   e do IP configurado. A mesma Ui16 pode ser alcançada por dois IPs (cabo e Wi-Fi da própria
 *   mesa); travar por IP deixaria duas cópias abrirem a mesma mesa. O equipamento fica escrito
 *   na trava e aparece na mensagem de recusa.
 * - lab: uma trava por arquivo de laboratório (caminho absoluto).
 * - mock: nenhuma (memória do próprio processo).
 */
export function ownerLockFile(mode: 'mock' | 'lab' | 'real', labFile: string, lockDir: string = sharedLockDir()): string | undefined {
  if (mode === 'real') return join(lockDir, 'mesa-real.lock');
  if (mode === 'lab') return `${resolve(labFile)}.lock`;
  return undefined;
}

export const equipmentLabel = (mixer: { model: string; ip: string }) => `mesa ${mixer.model} em ${mixer.ip}`;

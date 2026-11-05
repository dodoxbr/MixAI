import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { ParamRegistry } from '../core/params.js';
import { asParamKey, type ParamKey, type ParamValue } from '../core/revisions.js';
import { decodeValue, encodeValue } from '../core/state.js';

/** Versão atual do formato do arquivo do laboratório. */
export const LAB_SCHEMA_VERSION = 1;
export const LAB_FILE_KIND = 'mixai-lab-state';

const LabFileV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal(LAB_FILE_KIND),
  deviceProfile: z.string(),
  savedAt: z.string(),
  values: z.record(z.string(), z.union([z.number(), z.boolean(), z.literal('-inf')])),
  currentSnapshot: z.object({ show: z.string().optional(), snapshot: z.string().optional() }).default({}),
});
type LabFileV1 = z.infer<typeof LabFileV1>;

/** Arquivo gravado por uma versão MAIS NOVA do MixAI: não é lido nem sobrescrito. */
export class LabStateVersionError extends Error {}

export interface LabData {
  values: Map<ParamKey, ParamValue>;
  currentSnapshot: { show?: string; snapshot?: string };
}

export interface LoadResult extends LabData {
  source: 'main' | 'backup' | 'default';
  warnings: string[];
}

/**
 * Migrações por versão: cada função recebe o JSON da versão N e devolve o da N+1.
 * Hoje só existe a v1. Uma v2 futura acrescenta `1: (v1) => v2` aqui, sem quebrar arquivos antigos.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('conteúdo não é um objeto JSON');
  let obj = raw as Record<string, unknown>;
  const declared = obj.schemaVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) throw new Error('schemaVersion ausente ou inválido');
  let version: number = declared;
  if (version > LAB_SCHEMA_VERSION) {
    throw new LabStateVersionError(
      `o arquivo do laboratório é da versão ${version}, mais nova que a suportada (${LAB_SCHEMA_VERSION}). ` +
        'Atualize o MixAI; o arquivo não foi alterado.',
    );
  }
  while (version < LAB_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`sem migração da versão ${version}`);
    obj = step(obj);
    version = obj.schemaVersion as number;
  }
  return obj;
}

export interface LabStoreOptions {
  /** Repetições de rename no Windows (antivírus/indexador podem segurar o arquivo por instantes). */
  renameRetries?: number;
  now?: () => Date;
}

/**
 * Persistência do laboratório em JSON versionado:
 * - gravação atômica: arquivo temporário + fsync + rename sobre o principal;
 * - backup: antes de substituir um principal VÁLIDO, ele é copiado para `.bak`;
 * - recuperação: principal corrompido é guardado como `.corrupt-<data>` e o `.bak` é usado;
 *   sem `.bak` válido, começa do estado padrão. Arquivo de versão mais nova nunca é tocado.
 */
export class LabStore {
  readonly backupFile: string;
  /** O principal em disco é válido (lido com sucesso ou gravado por nós): pode virar backup. */
  private mainIsValid = false;

  constructor(
    readonly file: string,
    private registry: ParamRegistry,
    private deviceProfile: string,
    private opts: LabStoreOptions = {},
  ) {
    this.backupFile = `${file}.bak`;
  }

  load(): LoadResult {
    const warnings: string[] = [];
    this.cleanupTemp(warnings);

    if (existsSync(this.file)) {
      try {
        const data = this.readFile(this.file, warnings);
        this.mainIsValid = true;
        return { ...data, source: 'main', warnings };
      } catch (err) {
        if (err instanceof LabStateVersionError) throw err;
        const aside = `${this.file}.corrupt-${this.stamp()}`;
        warnings.push(`Arquivo do laboratório inválido (${(err as Error).message}); guardado como ${basename(aside)}.`);
        try {
          renameSync(this.file, aside);
        } catch {
          warnings.push('Não consegui mover o arquivo inválido; ele será substituído na próxima gravação.');
        }
      }
    }

    if (existsSync(this.backupFile)) {
      try {
        const data = this.readFile(this.backupFile, warnings);
        warnings.push(`Estado recuperado do backup (${basename(this.backupFile)}).`);
        return { ...data, source: 'backup', warnings };
      } catch (err) {
        if (err instanceof LabStateVersionError) throw err;
        warnings.push(`Backup também inválido (${(err as Error).message}); começando do estado padrão.`);
      }
    }
    return { values: this.defaults(), currentSnapshot: {}, source: 'default', warnings };
  }

  /** Gravação atômica. Lança erro se não conseguir gravar (o estado em memória continua válido). */
  save(data: LabData): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const content: LabFileV1 = {
      schemaVersion: 1,
      kind: LAB_FILE_KIND,
      deviceProfile: this.deviceProfile,
      savedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      values: Object.fromEntries([...data.values].map(([k, v]) => [k, encodeValue(v)])),
      currentSnapshot: data.currentSnapshot,
    };
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, `${JSON.stringify(content, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (this.mainIsValid && existsSync(this.file)) copyFileSync(this.file, this.backupFile);
    this.renameWithRetry(tmp, this.file);
    this.mainIsValid = true;
  }

  defaults(): Map<ParamKey, ParamValue> {
    return new Map(this.registry.specs().map((s) => [s.key, s.labDefault]));
  }

  private readFile(path: string, warnings: string[]): LabData {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const parsed = LabFileV1.parse(migrate(raw));
    if (parsed.deviceProfile !== this.deviceProfile) {
      throw new Error(`perfil de mesa diferente (${parsed.deviceProfile}, esperado ${this.deviceProfile})`);
    }
    const values = this.defaults();
    let unknownKeys = 0;
    let missing = 0;
    for (const [text, encoded] of Object.entries(parsed.values)) {
      const key = asParamKey(text);
      if (!key || !this.registry.has(key)) {
        unknownKeys++;
        continue;
      }
      const value = decodeValue(encoded);
      const problem = value === undefined ? `${text}: valor inválido` : this.registry.validate(key, value);
      if (problem) throw new Error(problem);
      values.set(key, value as ParamValue);
    }
    for (const key of this.registry.keys()) if (!(key in parsed.values)) missing++;
    if (unknownKeys) warnings.push(`${unknownKeys} parâmetro(s) desconhecido(s) no arquivo foram ignorados.`);
    if (missing) warnings.push(`${missing} parâmetro(s) ausente(s) no arquivo começaram com o valor padrão do laboratório.`);
    return { values, currentSnapshot: parsed.currentSnapshot };
  }

  private renameWithRetry(from: string, to: string) {
    const retries = this.opts.renameRetries ?? 5;
    for (let i = 0; ; i++) {
      try {
        renameSync(from, to);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i >= retries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          try {
            unlinkSync(from);
          } catch {
            /* ignora */
          }
          throw err;
        }
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until) {
          /* espera curta e síncrona: a gravação precisa terminar antes do processo sair */
        }
      }
    }
  }

  /** Remove temporários deixados por uma gravação interrompida (queda de energia, kill). */
  private cleanupTemp(warnings: string[]) {
    const dir = dirname(this.file);
    if (!existsSync(dir)) return;
    const prefix = `${basename(this.file)}.tmp-`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        unlinkSync(join(dir, name));
        warnings.push(`Gravação interrompida anterior descartada (${name}); o arquivo principal não foi afetado.`);
      } catch {
        /* ignora */
      }
    }
  }

  private stamp() {
    return (this.opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  }
}

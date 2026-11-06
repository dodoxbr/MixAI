import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParamRegistry } from './params.js';
import type { ParamKey, ParamValue } from './revisions.js';
import {
  buildScene,
  SceneDescriptionSchema,
  SceneIdSchema,
  SceneNameSchema,
  validateScene,
  type DeviceProfile,
  type Scene,
  type SceneValidation,
} from './scene.js';

/** Limites de segurança do armazenamento. */
export const MAX_SCENES = 200;
export const MAX_SCENE_FILE_BYTES = 256 * 1024;

export interface SceneSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  validationStatus: Scene['validationStatus'];
  deviceProfile: DeviceProfile;
  params: number;
  /** Quantos parâmetros por status de compatibilidade com a mesa real. */
  compat: { compatible: number; incompatible: number; unknown: number };
}

export type StoreResult<T> = { ok: true; value: T; warnings?: string[] } | { ok: false; code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | SceneValidation['code']; message: string; errors?: string[] };

/**
 * Cenas do MixAI em disco: data/scenes/<id>.json (pasta fora do Git).
 * - gravação atômica (arquivo temporário + rename);
 * - o nome do arquivo é o id (gerado aqui), nunca o nome dado pelo usuário;
 * - nomes únicos (sem diferenciar maiúsculas);
 * - excluir MOVE para data/scenes/excluidas/ (dá para recuperar à mão);
 * - importar sempre cria uma cena NOVA (id novo); nunca sobrescreve e nunca aplica nada.
 */
export class SceneStore {
  readonly dir: string;
  private readonly trash: string;

  constructor(
    dir: string,
    private registry: ParamRegistry,
    private device: DeviceProfile,
    private clock: () => number = Date.now,
  ) {
    this.dir = dir;
    this.trash = join(dir, 'excluidas');
  }

  private now() {
    return new Date(this.clock());
  }

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  private newId(): string {
    let id: string;
    do id = `cena-${randomBytes(6).toString('hex')}`;
    while (existsSync(this.file(id)));
    return id;
  }

  /** Lista as cenas válidas e aponta os arquivos que não puderam ser lidos (sem apagá-los). */
  list(): { scenes: SceneSummary[]; invalid: Array<{ file: string; error: string; reason: string }> } {
    const scenes: SceneSummary[] = [];
    const invalid: Array<{ file: string; error: string; reason: string }> = [];
    if (!existsSync(this.dir)) return { scenes, invalid };
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const r = this.readFile(join(this.dir, f));
      if (!r.ok) {
        invalid.push({ file: f, error: r.message, reason: r.code ?? 'INVALID' });
        continue;
      }
      scenes.push(summarize(r.value));
    }
    scenes.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
    return { scenes, invalid };
  }

  get(id: string): StoreResult<Scene> {
    if (!SceneIdSchema.safeParse(id).success) return { ok: false, code: 'NOT_FOUND', message: 'Cena não encontrada.' };
    const path = this.file(id);
    if (!existsSync(path)) return { ok: false, code: 'NOT_FOUND', message: 'Cena não encontrada (foi excluída?).' };
    return this.readFile(path);
  }

  /** Cria uma cena com os valores dados (o estado atual do laboratório). */
  create(input: { name: string; description?: string; values: Map<ParamKey, ParamValue>; source?: Scene['source'] }): StoreResult<Scene> {
    const named = this.checkNames(input.name, input.description);
    if (!named.ok) return named;
    if (this.count() >= MAX_SCENES) return { ok: false, code: 'CONFLICT', message: `Limite de ${MAX_SCENES} cenas atingido. Exclua alguma antes.` };
    const scene = buildScene({
      id: this.newId(),
      name: named.value.name,
      description: named.value.description,
      device: this.device,
      values: input.values,
      registry: this.registry,
      now: this.now(),
      source: input.source,
    });
    return this.write(scene);
  }

  duplicate(id: string, name?: string): StoreResult<Scene> {
    const src = this.get(id);
    if (!src.ok) return src;
    const wanted = name?.trim() || this.freeName(`${src.value.name} (cópia)`);
    const named = this.checkNames(wanted, src.value.description);
    if (!named.ok) return named;
    if (this.count() >= MAX_SCENES) return { ok: false, code: 'CONFLICT', message: `Limite de ${MAX_SCENES} cenas atingido.` };
    const now = this.now().toISOString();
    return this.write({ ...src.value, id: this.newId(), name: named.value.name, createdAt: now, updatedAt: now });
  }

  /** Renomeia e/ou troca a descrição. Os valores da cena não mudam. */
  update(id: string, patch: { name?: string; description?: string }): StoreResult<Scene> {
    const src = this.get(id);
    if (!src.ok) return src;
    const named = this.checkNames(patch.name ?? src.value.name, patch.description ?? src.value.description, id);
    if (!named.ok) return named;
    return this.write({ ...src.value, name: named.value.name, description: named.value.description, updatedAt: this.now().toISOString() });
  }

  /** Exclui (move para excluidas/). Exige o nome atual, para não apagar a cena errada. */
  remove(id: string, expectedName: string): StoreResult<{ id: string; name: string }> {
    const src = this.get(id);
    if (!src.ok) return src;
    if (src.value.name.trim().toLocaleLowerCase('pt-BR') !== expectedName.trim().toLocaleLowerCase('pt-BR')) {
      return { ok: false, code: 'CONFLICT', message: `Confirmação não confere: a cena se chama "${src.value.name}". Nada foi excluído.` };
    }
    mkdirSync(this.trash, { recursive: true });
    renameSync(this.file(id), join(this.trash, `${id}-${this.now().toISOString().replace(/[:.]/g, '-')}.json`));
    return { ok: true, value: { id, name: src.value.name } };
  }

  /** Texto JSON da cena, exatamente como guardada (pronto para levar a outro computador). */
  exportJson(id: string): StoreResult<{ fileName: string; json: string }> {
    const src = this.get(id);
    if (!src.ok) return src;
    const slug = src.value.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cena';
    return { ok: true, value: { fileName: `mixai-cena-${slug}.json`, json: `${JSON.stringify(src.value, null, 2)}\n` } };
  }

  /**
   * Importa o texto de um arquivo de cena. Valida tudo (JSON, versão, equipamento, faixas) e
   * guarda como cena NOVA. Nunca aplica nada na mesa.
   */
  importJson(text: string): StoreResult<Scene> {
    if (Buffer.byteLength(text, 'utf8') > MAX_SCENE_FILE_BYTES) {
      return { ok: false, code: 'INVALID', message: `Arquivo grande demais (máximo ${MAX_SCENE_FILE_BYTES / 1024} KB).` };
    }
    const v = validateScene(text, this.registry, this.device);
    if (!v.ok || !v.scene) {
      return { ok: false, code: v.code ?? 'INVALID', message: `Cena recusada: ${v.errors.slice(0, 5).join('; ')}`, errors: v.errors };
    }
    if (this.count() >= MAX_SCENES) return { ok: false, code: 'CONFLICT', message: `Limite de ${MAX_SCENES} cenas atingido.` };
    const now = this.now().toISOString();
    const scene: Scene = {
      ...v.scene,
      id: this.newId(),
      name: this.freeName(v.scene.name),
      updatedAt: now,
      source: { ...(v.scene.source ?? {}), mode: 'import' },
    };
    const saved = this.write(scene);
    if (!saved.ok) return saved;
    const warnings = [...v.warnings];
    if (scene.name !== v.scene.name) warnings.push(`já existia uma cena "${v.scene.name}": a importada se chama "${scene.name}".`);
    return { ok: true, value: saved.value, warnings };
  }

  // ---------- internos ----------

  private count(): number {
    return existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith('.json')).length : 0;
  }

  private readFile(path: string): StoreResult<Scene> {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      return { ok: false, code: 'INVALID', message: `não foi possível ler (${(err as Error).message})` };
    }
    const v = validateScene(text, this.registry, this.device);
    // Lida do disco vale a MESMA regra da importação: só cena totalmente válida para ESTA mesa.
    // Outro modelo (DEVICE_MISMATCH) nunca é consultado, comparado nem carregado; o arquivo
    // fica intacto no disco (nada é apagado nem reescrito).
    if (!v.ok || !v.scene) {
      const why = v.errors.join('; ');
      const message =
        v.code === 'DEVICE_MISMATCH'
          ? `Cena incompatível com esta mesa: ${why} O arquivo foi mantido em data/scenes, mas não pode ser consultado, comparado nem carregado.`
          : why;
      return { ok: false, code: v.code ?? 'INVALID', message, errors: v.errors };
    }
    if (`${v.scene.id}.json` !== path.split(/[\\/]/).pop()) return { ok: false, code: 'INVALID', message: 'o id dentro do arquivo não confere com o nome do arquivo' };
    return { ok: true, value: v.scene, warnings: v.warnings };
  }

  private write(scene: Scene): StoreResult<Scene> {
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(scene.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(scene, null, 2)}\n`);
    renameSync(tmp, path);
    return { ok: true, value: scene };
  }

  private checkNames(name: string, description: string | undefined, selfId?: string): StoreResult<{ name: string; description: string }> {
    const n = SceneNameSchema.safeParse(name);
    if (!n.success) return { ok: false, code: 'INVALID', message: `Nome inválido: ${n.error.issues[0]!.message}.` };
    const d = SceneDescriptionSchema.safeParse(description ?? '');
    if (!d.success) return { ok: false, code: 'INVALID', message: `Descrição inválida: ${d.error.issues[0]!.message}.` };
    const taken = this.list().scenes.find((s) => s.id !== selfId && same(s.name, n.data));
    if (taken) return { ok: false, code: 'CONFLICT', message: `Já existe uma cena chamada "${taken.name}". Escolha outro nome.` };
    return { ok: true, value: { name: n.data, description: d.data } };
  }

  /** Nome livre: "Ensaio", "Ensaio (importada)", "Ensaio (importada 2)"... ou "(cópia)". */
  private freeName(base: string): string {
    const names = this.list().scenes.map((s) => s.name);
    if (!names.some((n) => same(n, base))) return base;
    const root = base.replace(/ \((cópia|importada)(?: \d+)?\)$/, '');
    const tag = base.endsWith('(cópia)') ? 'cópia' : 'importada';
    for (let i = 1; ; i++) {
      const candidate = `${root} (${tag}${i > 1 ? ` ${i}` : ''})`.slice(0, 60);
      if (!names.some((n) => same(n, candidate))) return candidate;
    }
  }
}

function same(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('pt-BR') === b.trim().toLocaleLowerCase('pt-BR');
}

function summarize(s: Scene): SceneSummary {
  const compat = { compatible: 0, incompatible: 0, unknown: 0 };
  for (const p of Object.values(s.params)) compat[p.status]++;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    validationStatus: s.validationStatus,
    deviceProfile: s.deviceProfile,
    params: Object.keys(s.params).length,
    compat,
  };
}

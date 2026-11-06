import { createHash, randomBytes } from 'node:crypto';
import type { MixController, Result } from '../core/controller.js';
import type { ActionLog } from '../core/log.js';
import type { ParamKey } from '../core/revisions.js';
import { loadTargets, sceneDiff, sceneValues, sceneView, type DiffContext, type Scene } from '../core/scene.js';
import type { SceneStore, StoreResult } from '../core/scene-store.js';
import type { Command } from './commands.js';
import type { Principal } from './auth.js';
import { actorOf, type AccessPolicy } from './policy.js';

/** Validade de uma comparação (prévia) para pedir o carregamento. */
export const PREVIEW_TTL_MS = 5 * 60_000;

type SceneCommand = Extract<Command, { type: `scene_${string}` }>;

interface Preview {
  id: string;
  sceneId: string;
  hash: string;
  principalId: string;
  revisions: Array<[ParamKey, number]>;
  expiresAt: number;
}

/** Conteúdo que importa para aplicar: valores e equipamento (nome/descrição não entram). */
export function sceneHash(scene: Scene): string {
  const params = Object.keys(scene.params)
    .sort()
    .map((k) => [k, scene.params[k]!.value]);
  return createHash('sha256').update(JSON.stringify({ d: scene.deviceProfile, p: params })).digest('hex');
}

/**
 * Cenas do MixAI no servidor (E5). Só o OPERADOR chega aqui (a autorização é feita antes,
 * em authorizeCommand). Carregar segue SEMPRE: comparar → pedir → pendência (E2) → aprovar.
 * Nada aqui escreve na mesa sem passar pelo controlador (fila única, travas, desfazer).
 */
export class ScenesService {
  private previews = new Map<string, Preview>();

  constructor(
    private controller: MixController,
    private store: SceneStore,
    private log: ActionLog,
    private opts: { mode: 'lab' | 'mock' | 'real'; policy: () => AccessPolicy; clock?: () => number },
  ) {}

  private now() {
    return (this.opts.clock ?? Date.now)();
  }

  /** Só o LABORATÓRIO tem cenas que se comparam e carregam nesta etapa. */
  get labOnly(): boolean {
    return this.opts.mode === 'lab' && this.controller.mixer.mode === 'lab';
  }

  private ctx(): Omit<DiffContext, 'read'> {
    const lim = this.controller.limits();
    return {
      registry: this.controller.registry,
      names: this.controller.names,
      musicianAux: this.opts.policy().musicianAux,
      ceilings: { channel: lim.maxChannelLevelDB, aux: lim.maxAuxSendDB, master: lim.maxMasterLevelDB },
    };
  }

  private notLab(what: string): Result {
    return {
      ok: false,
      code: 'MODE_MISMATCH',
      message: `${what} só existe no LABORATÓRIO nesta etapa. Nenhuma cena é enviada à mesa real.`,
    };
  }

  private audit(p: Principal, action: string, ok: boolean, message: string, details: Record<string, unknown> = {}) {
    this.log.add({ action, ok, message, details: { ...details, by: actorOf(p) } });
  }

  async handle(p: Principal, cmd: SceneCommand): Promise<Result> {
    switch (cmd.type) {
      case 'scene_list': {
        const { scenes, invalid } = this.store.list();
        return {
          ok: true,
          code: 'OK',
          message: `${scenes.length} cena(s) do MixAI${invalid.length ? `; ${invalid.length} arquivo(s) em data/scenes não podem ser usados (ilegíveis ou de outro equipamento)` : ''}.`,
          data: { scenes, invalid, canLoad: this.labOnly },
        };
      }
      case 'scene_get': {
        const r = this.store.get(cmd.id);
        if (!r.ok) return storeFail(r);
        const view = sceneView(r.value, this.ctx());
        return { ok: true, code: 'OK', message: `Cena "${r.value.name}".`, data: { scene: summaryOf(r.value), rows: view.rows, unknownKeys: view.unknownKeys, warnings: r.warnings ?? [] } };
      }
      case 'scene_save': {
        if (!this.labOnly) return this.notLab('Salvar cena a partir do estado atual');
        const keys = this.controller.registry.keys();
        const snap = this.controller.state.snapshot(keys).params;
        const values = new Map();
        for (const k of keys) {
          const v = snap[k]?.value;
          if (v?.status === 'known') values.set(k, v.value);
        }
        const r = this.store.create({ name: cmd.name, description: cmd.description, values, source: { mode: 'lab', app: 'MixAI' } });
        if (!r.ok) return storeFail(r);
        this.audit(p, 'scene_save', true, `Cena salva: "${r.value.name}" (${values.size} parâmetros).`, { scene: r.value.id });
        return { ok: true, code: 'OK', message: `Cena "${r.value.name}" salva com o estado atual do laboratório (${values.size} parâmetros). Nada foi alterado na mesa.`, data: { scene: summaryOf(r.value) } };
      }
      case 'scene_duplicate': {
        const r = this.store.duplicate(cmd.id, cmd.name);
        if (!r.ok) return storeFail(r);
        this.audit(p, 'scene_duplicate', true, `Cena duplicada: "${r.value.name}".`, { scene: r.value.id, from: cmd.id });
        return { ok: true, code: 'OK', message: `Cópia criada: "${r.value.name}".`, data: { scene: summaryOf(r.value) } };
      }
      case 'scene_update': {
        const r = this.store.update(cmd.id, { name: cmd.name, description: cmd.description });
        if (!r.ok) return storeFail(r);
        this.audit(p, 'scene_update', true, `Cena atualizada: "${r.value.name}".`, { scene: r.value.id });
        return { ok: true, code: 'OK', message: `Cena "${r.value.name}" atualizada.`, data: { scene: summaryOf(r.value) } };
      }
      case 'scene_delete': {
        const r = this.store.remove(cmd.id, cmd.expectedName);
        if (!r.ok) return storeFail(r);
        for (const [id, pv] of this.previews) if (pv.sceneId === cmd.id) this.previews.delete(id);
        this.audit(p, 'scene_delete', true, `Cena excluída: "${r.value.name}" (movida para data/scenes/excluidas).`, { scene: cmd.id });
        return { ok: true, code: 'OK', message: `Cena "${r.value.name}" excluída.`, data: r.value };
      }
      case 'scene_export': {
        const r = this.store.exportJson(cmd.id);
        if (!r.ok) return storeFail(r);
        return { ok: true, code: 'OK', message: `Exportação pronta: ${r.value.fileName}.`, data: r.value };
      }
      case 'scene_import': {
        const r = this.store.importJson(cmd.json);
        if (!r.ok) {
          this.audit(p, 'scene_import', false, r.message, { code: r.code });
          return { ok: false, code: 'INVALID', message: r.message, data: { reason: r.code, errors: r.errors ?? [] } };
        }
        this.audit(p, 'scene_import', true, `Cena importada: "${r.value.name}". Nada foi aplicado.`, { scene: r.value.id });
        return {
          ok: true,
          code: 'OK',
          message: `Cena "${r.value.name}" importada. Nada foi aplicado na mesa: para usar, compare e carregue.`,
          data: { scene: summaryOf(r.value), warnings: r.warnings ?? [] },
        };
      }
      case 'scene_compare':
        return this.compare(p, cmd.id);
      case 'scene_load':
        return this.requestLoad(p, cmd.id, cmd.previewId);
    }
  }

  /** Passo 2–3: calcula as diferenças e guarda uma PRÉVIA presa às revisões atuais. */
  private compare(p: Principal, id: string): Result {
    if (!this.labOnly) return this.notLab('Comparar e carregar cenas');
    this.prune();
    const r = this.store.get(id);
    if (!r.ok) return storeFail(r);
    const ctx = this.ctx();
    const values = sceneValues(r.value, ctx.registry);
    const keys = loadTargets(values, ctx).map((t) => t.key);
    const snap = this.controller.state.snapshot(keys).params;
    const diff = sceneDiff(values, {
      ...ctx,
      read: (k) => {
        const v = this.controller.state.snapshot([k]).params[k]?.value;
        return v?.status === 'known' ? v.value : undefined;
      },
    });
    const preview: Preview = {
      id: `pv-${randomBytes(8).toString('hex')}`,
      sceneId: id,
      hash: sceneHash(r.value),
      principalId: p.id,
      revisions: keys.map((k) => [k, snap[k]?.revision ?? 0]),
      expiresAt: this.now() + PREVIEW_TTL_MS,
    };
    this.previews.set(preview.id, preview);
    return {
      ok: true,
      code: 'OK',
      message: diff.totals.applicable
        ? `${diff.totals.applicable} alteração(ões) seriam aplicadas ao carregar "${r.value.name}"${diff.totals.notApplicable ? ` (${diff.totals.notApplicable} diferença(s) ainda não aplicável(is))` : ''}. Nada foi alterado.`
        : `A cena "${r.value.name}" não muda nenhum parâmetro aplicável em relação ao estado atual.`,
      data: { scene: summaryOf(r.value), previewId: preview.id, expiresAt: new Date(preview.expiresAt).toISOString(), ...diff },
    };
  }

  /** Passos 4–5: pedido de carregamento → pendência de aprovação (mecanismo da E2). */
  private async requestLoad(p: Principal, id: string, previewId: string): Promise<Result> {
    if (!this.labOnly) return this.notLab('Carregar cenas');
    this.prune();
    const pv = this.previews.get(previewId);
    if (!pv || pv.sceneId !== id || pv.principalId !== p.id) {
      return { ok: false, code: 'CONFIRMATION_STALE', message: 'A comparação expirou ou não é desta cena. Compare de novo antes de carregar.' };
    }
    this.previews.delete(previewId); // uma prévia, um pedido
    const r = this.store.get(id);
    if (!r.ok) return storeFail(r);
    if (sceneHash(r.value) !== pv.hash) return { ok: false, code: 'CONFIRMATION_STALE', message: 'A cena mudou desde a comparação. Compare de novo.' };
    return this.controller.loadScene({
      sceneId: id,
      sceneName: r.value.name,
      hash: pv.hash,
      targets: loadTargets(sceneValues(r.value, this.ctx().registry), this.ctx()),
      expect: { revisions: pv.revisions },
      origin: p.role,
      actor: actorOf(p),
    });
  }

  /**
   * Passos 6–7: o operador aprovou o cartão. Relê a cena (tem de ser a MESMA da pendência) e
   * aplica pela fila. A pendência confere as revisões de todos os parâmetros da cena.
   */
  async applyApproved(requester: { role: Principal['role']; label: string }, cmd: { id: string }, pendingId: string, approver: Principal): Promise<Result> {
    if (!this.labOnly) return this.notLab('Carregar cenas');
    const r = this.store.get(cmd.id);
    if (!r.ok) return { ...storeFail(r), message: `${storeFail(r).message} A pendência não foi aplicada.` };
    return this.controller.loadScene({
      sceneId: cmd.id,
      sceneName: r.value.name,
      hash: sceneHash(r.value),
      targets: loadTargets(sceneValues(r.value, this.ctx().registry), this.ctx()),
      confirmationId: pendingId,
      origin: requester.role,
      actor: `${requester.label}; aprovado por ${actorOf(approver)}`,
    });
  }

  private prune() {
    const now = this.now();
    for (const [id, pv] of this.previews) if (pv.expiresAt < now) this.previews.delete(id);
  }
}

function summaryOf(s: Scene) {
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

function storeFail(r: Extract<StoreResult<unknown>, { ok: false }>): Result {
  // DEVICE_MISMATCH vira INVALID com data.reason = DEVICE_MISMATCH (a tela mostra a mensagem).
  const code = r.code === 'NOT_FOUND' ? 'NOT_FOUND' : r.code === 'CONFLICT' ? 'CONFLICT' : 'INVALID';
  return { ok: false, code, message: r.message, data: { reason: r.code, errors: r.errors ?? [] } };
}

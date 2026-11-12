import { createHash, randomBytes } from 'node:crypto';
import { ProposalBuilder, type Proposal } from '../../assistant/proposals.js';
import type { Intent } from '../../assistant/intent.js';
import type { ParamKey, ParamValue } from '../../core/revisions.js';
import { Ui16RealBridge } from '../../mixer/ui16-real-bridge.js';
import { isAuxLevel, type AuxObservation } from '../../mixer/ui16-aux-write.js';
import { UI16_CONTROL_CATEGORIES, controlCategory, validControlChange, type Ui16ControlCategory } from '../../mixer/ui16-controls.js';
import type { Principal } from '../auth.js';
import { fail, type ServerCore, type CommandResponse } from '../core.js';

interface Prepared {
  proposal: Proposal;
  key: ParamKey;
  sample: AuxObservation;
  target: ParamValue;
  running?: { requestId: string; response: Promise<unknown> };
  result?: { requestId: string; response: unknown };
}
/** Human preview/apply adapter. Never executes mixer writes: all execution uses ServerCore's sole queue. */
export class FirstRealAuxService {
  private prepared = new Map<string, Prepared>();
  private locks = new Set<ParamKey>();
  private builder: ProposalBuilder;
  constructor(
    private core: ServerCore,
    private now = () => Date.now(),
  ) {
    this.builder = new ProposalBuilder(
      core.controller,
      core.policy,
      15000,
      now,
    );
    core.auth.onRevoke((id) => {
      for (const [key, p] of this.prepared)
        if (p.proposal.ownerId === id && !p.running) this.prepared.delete(key);
    });
  }
  private bridge() {
    return this.core.mode === 'real' &&
      this.core.mixer instanceof Ui16RealBridge
      ? this.core.mixer
      : undefined;
  }
  private access(p: Principal, mode: unknown, serverId: unknown) {
    if (p.role !== 'operator' || !this.core.auth.isActive(p))
      return fail(
        'FORBIDDEN',
        'Só uma sessão autenticada de operador pode autorizar controles REAL.',
      );
    if (
      mode !== 'real' ||
      this.core.mode !== 'real' ||
      this.core.mixer.mode !== 'real'
    )
      return fail(
        'MODE_MISMATCH',
        'Selecione explicitamente REAL nesta operação.',
      );
    if (serverId !== this.core.serverId)
      return fail(
        'SERVER_CHANGED',
        'Confira a instância atual antes de autorizar.',
      );
    if (!this.bridge()?.auxHandshake.available())
      return fail(
        'DEGRADED_READ_ONLY',
        'Escrita REAL desabilitada ou sem identificação/conexão/rota válidas.',
      );
    return undefined;
  }
  /**
   * Estado somente leitura para a tela supervisionada. Não prepara, não autoriza e não toca o transporte.
   * `observed` só existe com amostra independente recente do alvo exato; nunca vem de cache otimista.
   */
  status(p: Principal, query: { channel?: number; aux?: number } = {}) {
    const bridge = this.bridge();
    const names = this.core.controller.names;
    const gate = bridge?.auxHandshake.gate;
    const available = !!bridge?.auxHandshake.available('ch.1.aux.1.level');
    let observed: number | '-inf' | null = null;
    const registered =
      Number.isInteger(query.channel) && Number.isInteger(query.aux) &&
      names.inputs.configured().includes(query.channel!) && names.aux.configured().includes(query.aux!);
    if (registered && bridge) {
      const sample = bridge.auxHandshake.current(`ch.${query.channel}.aux.${query.aux}.level` as ParamKey);
      if (sample && typeof sample.value === 'number') observed = sample.value === -Infinity ? '-inf' : sample.value;
    }
    return {
      serverId: this.core.serverId,
      mode: this.core.mode,
      model: this.core.mixer.capabilities().model,
      link: this.core.mixer.link(),
      feature: {
        gate: !!gate,
        validation: gate?.validation ?? null,
        available,
        state: !bridge ? 'not_real' : !gate ? 'disabled' : available ? 'enabled' : 'blocked',
      },
      stepDB: 0.5,
      maxStepDB: Math.min(1, this.core.controller.limits().maxStepDB),
      channels: names.inputs.list().filter((c) => names.inputs.configured().includes(c.number)).map((c) => ({ number: c.number, name: c.name })),
      aux: names.aux.list().filter((a) => names.aux.configured().includes(a.number)).map((a) => ({ number: a.number, name: a.name })),
      observed,
    };
  }
  preview(
    p: Principal,
    input: {
      targetMode: unknown;
      serverId: unknown;
      channel?: number;
      aux?: number;
      deltaDB?: number;
      undo?: boolean;
    },
  ) {
    const blocked = this.access(p, input.targetMode, input.serverId);
    if (blocked) return { result: blocked };
    if (input.undo) {
      const top = this.core.controller.peekUndo();
      if (!top || top.keys.length !== 1 || !isAuxLevel(top.keys[0]!)) return { result: fail('INVALID', 'Desfazer AUX exige um único envio AUX.') };
    }
    if (!input.undo && (!Number.isInteger(input.channel) || !Number.isInteger(input.aux) || !Number.isFinite(input.deltaDB) || Math.abs(input.deltaDB!) > 1 || input.deltaDB === 0)) return { result: fail('INVALID', 'Passo AUX exige até 1 dB.') };
    return this.previewIntent(p, input.undo ? { type: 'undo' } : { type: 'level', channel: input.channel!, dest: 'fones', aux: input.aux!, deltaDB: input.deltaDB }, 'local');
  }
  /** Shared proposal boundary for API and natural-language assistant. Never executes here. */
  previewIntent(p: Principal, intent: Intent, source: Proposal['card']['source'] = 'local') {
    const blocked = this.access(p, 'real', this.core.serverId);
    if (blocked) return { result: blocked };
    if (!['level', 'mute', 'undo'].includes(intent.type) || (intent.type === 'mute' && intent.channels.length !== 1))
      return { result: fail('INVALID', 'Somente volume/mute de um canal por operação; master e lote bloqueados.') };
    const names = this.core.controller.names;
    if (intent.type === 'level' || intent.type === 'mute') {
      const channel = intent.type === 'level' ? intent.channel : intent.channels[0]!;
      const aux = intent.dest === 'fones' ? intent.aux ?? this.core.policy.musicianAux : undefined;
      if (!names.inputs.configured().includes(channel) || (aux !== undefined && !names.aux.configured().includes(aux))) return { result: fail('INVALID', 'Canal/AUX precisa estar cadastrado.') };
    }
    if (intent.type === 'undo') {
      const top = this.core.controller.peekUndo();
      if (!top || top.keys.length !== 1 || !controlCategory(top.keys[0]!) || top.keys[0] === 'master.level') return { result: fail('INVALID', 'Desfazer exige um único parâmetro autorizado.') };
    }
    const built = this.builder.build(p, intent, source);
    if (!built.ok) return { result: fail('INVALID', built.message) };
    const pr = built.proposal, parameters = pr.card.parameters;
    if (!parameters || parameters.length !== 1) return { result: fail('INVALID', 'Uma operação exige exatamente um parâmetro.') };
    const { key, previous, target } = parameters[0]!;
    const category = controlCategory(key);
    if (!this.bridge()!.auxHandshake.enabled(key)) return { result: fail('FORBIDDEN', 'Esta categoria REAL não foi habilitada pelo bootstrap confiável.') };
    const match = /^ch\.(\d+)\.(?:main|aux\.(\d+))\.(?:level|mute)$/.exec(key);
    if (
      !category || !match ||
      !names.inputs.configured().includes(Number(match[1])) ||
      (match[2] && !names.aux.configured().includes(Number(match[2]))) ||
      previous === '-inf' || target === '-inf' ||
      !validControlChange(key, previous, target) ||
      (typeof target === 'number' && typeof previous === 'number' &&
        Math.abs(target - previous) > Math.min(1, this.core.controller.limits().maxStepDB))
    )
      return { result: fail('INVALID', 'Parâmetro/origem/alvo fora do escopo: um mute ou até 1 dB; nenhum lote/master.') };
    const sample = this.bridge()!.auxHandshake.current(key);
    if (!sample || (typeof previous === 'boolean' ? sample.value !== previous : typeof sample.value !== 'number' || Math.abs(sample.value - previous) > 0.05)) return { result: fail('STATE_CHANGED', 'Leitura independente indisponível, antiga ou diferente; obtenha nova observação.') };
    for (const [id, old] of this.prepared)
      if (this.now() > old.proposal.expiresAtMs + 60000 && !old.running)
        this.prepared.delete(id);
    if (this.prepared.size >= 100)
      return {
        result: fail(
          'RATE_LIMIT',
          'Limite de prévias atingido; aguarde a expiração.',
        ),
      };
    pr.card.needsApproval = true;
    pr.card.reason =
      `REAL: confirmação humana de ${category}, um canal por operação, volume até 1 dB. AUX1/HA800 é compartilhado. Não é medição de áudio.`;
    pr.card.realControl = { targetMode: 'real', serverId: this.core.serverId, category, confirmationPath: `/api/ui16/controls/${pr.card.id}/confirm` };
    this.prepared.set(pr.card.id, {
      proposal: pr,
      key,
      sample: { ...sample },
      target,
    });
    return {
      proposal: pr.card,
      previous,
      requested: target,
      observed: sample.value,
      source: 'independent_socket_input',
      validation: this.bridge()!.auxHandshake.gateFor(key)!.validation,
    };
  }
  capabilities(p: Principal) {
    if (p.role !== 'operator' || !this.core.auth.isActive(p)) return { result: fail('FORBIDDEN', 'Sessão de operador obrigatória.') };
    const bridge = this.bridge();
    return { schemaVersion: 1, targetMode: 'real', serverId: this.core.serverId,
      categories: UI16_CONTROL_CATEGORIES.map(category => {
        const key: ParamKey = category === 'master_level' ? 'master.level' : `ch.1.${category.startsWith('aux') ? 'aux.1' : 'main'}.${category.endsWith('mute') ? 'mute' : 'level'}`;
        return { category, enabled: bridge?.auxHandshake.enabled(key) ?? false, available: bridge?.auxHandshake.available(key) ?? false,
          ...(category === 'master_level' ? { reason: 'separate_approval_and_physical_validation_pending' } : {}) };
      }), master: bridge?.reading('master.level') ?? { state: 'unavailable' } };
  }
  previewControl(p: Principal, input: { targetMode: unknown; serverId: unknown; operation?: 'level' | 'mute' | 'master'; channel?: number; aux?: number; deltaDB?: number; muted?: boolean; undo?: boolean }) {
    const blocked = this.access(p, input.targetMode, input.serverId);
    if (blocked) return { result: blocked };
    if (input.undo) return this.previewIntent(p, { type: 'undo' });
    if (input.operation === 'master') return { result: fail('FORBIDDEN', 'Master somente leitura; aprovação e validação física específicas pendentes.') };
    if (input.operation === 'mute' && typeof input.muted === 'boolean') return this.previewIntent(p, { type: 'mute', channels: [input.channel!], dest: input.aux === undefined ? 'pa' : 'fones', aux: input.aux, muted: input.muted });
    if (input.operation === 'level' && Number.isFinite(input.deltaDB) && input.deltaDB !== 0 && Math.abs(input.deltaDB!) <= 1) return this.previewIntent(p, { type: 'level', channel: input.channel!, dest: input.aux === undefined ? 'pa' : 'fones', aux: input.aux, deltaDB: input.deltaDB });
    return { result: fail('INVALID', 'Selecione um volume de até 1 dB ou um mute, sem lote.') };
  }
  apply(
    p: Principal,
    id: string,
    input: {
      requestId: string;
      targetMode: unknown;
      serverId: unknown;
      humanConfirmed: unknown;
    },
    scope?: Ui16ControlCategory,
  ): Promise<unknown> {
    const blocked = this.access(p, input.targetMode, input.serverId);
    if (blocked) return Promise.resolve({ result: blocked });
    if (
      input.humanConfirmed !== true ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(input.requestId)
    )
      return Promise.resolve({
        result: fail(
          'FORBIDDEN',
          'Confirmação humana explícita e requestId são obrigatórios.',
        ),
      });
    const prepared = this.prepared.get(id);
    if (!prepared || prepared.proposal.ownerId !== p.id)
      return Promise.resolve({
        result: fail('NOT_FOUND', 'Prévia não encontrada nesta sessão.'),
      });
    if (scope && controlCategory(prepared.key) !== scope) return Promise.resolve({ result: fail('FORBIDDEN', 'Categoria de confirmação incompatível.') });
    if (prepared.running)
      return prepared.running.requestId === input.requestId
        ? prepared.running.response
        : Promise.resolve({
            result: fail('CONFLICT', 'Operação já em andamento; não reenvie.'),
          });
    if (prepared.result)
      return prepared.result.requestId === input.requestId
        ? Promise.resolve(prepared.result.response)
        : Promise.resolve({
            result: fail('CONFIRMATION_USED', 'Autorização já consumida.'),
          });
    if (this.now() > prepared.proposal.expiresAtMs)
      return Promise.resolve({
        result: fail(
          'CONFIRMATION_EXPIRED',
          'Confirmação expirada. Faça nova prévia.',
        ),
      });
    if (this.locks.has(prepared.key))
      return Promise.resolve({
        result: fail('CONFLICT', 'Outro ajuste deste envio está em andamento.'),
      });
    this.locks.add(prepared.key);
    const response = this.execute(p, prepared, input).finally(() => {
      this.locks.delete(prepared.key);
      prepared.running = undefined;
    });
    prepared.running = { requestId: input.requestId, response };
    return response.then((result) => {
      prepared.result = { requestId: input.requestId, response: result };
      return result;
    });
  }
  private async execute(
    p: Principal,
    prepared: Prepared,
    input: { requestId: string; serverId: unknown },
  ) {
    const bridge = this.bridge()!;
    const pr = prepared.proposal;
    const operationId = randomBytes(12).toString('hex');
    const authorized = () =>
      p.role === 'operator' &&
      this.core.auth.isActive(p) &&
      this.now() <= pr.expiresAtMs &&
      this.bridge() === bridge &&
      bridge.auxHandshake.available(prepared.key);
    let response: CommandResponse;
    try {
      response = await this.core.execute(
        p,
        {
          requestId:
            'realaux:' +
            createHash('sha256')
              .update(pr.card.id + ':' + input.requestId)
              .digest('hex')
              .slice(0, 48),
          serverId: input.serverId,
          targetMode: 'real',
          command: pr.command,
        },
        {
          expect: {
            revisions: pr.bound,
            undoId: pr.undoId,
            authorize: () => {
              if (!authorized()) return false;
              try {
                bridge.auxHandshake.authorize({
                  id: operationId,
                  key: prepared.key,
                  previous: prepared.sample,
                  requested: prepared.target,
                  authorized,
                });
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      );
    } catch {
      response = {
        requestId: input.requestId,
        duplicate: false,
        result: fail(
          'INDETERMINATE',
          'Não foi possível determinar o resultado; confira o estado antes de uma nova autorização.',
        ),
      };
    } finally {
      bridge.auxHandshake.cancelAuthorization(operationId);
    }
    const observation = bridge.auxHandshake.report(operationId);
    if (response.result.ok && observation?.status !== 'observed_target') {
      response = {
        ...response,
        result: {
          ...response.result,
          ok: false,
          code: 'STATE_CHANGED',
          message:
            'Nada confirmado: o executor não aplicou uma operação observável; confira o estado e faça nova prévia.',
        },
      };
    }
    const current = bridge.auxHandshake.current(prepared.key)?.value;
    return {
      ...response,
      requestId: input.requestId,
      confirmation: observation ?? {
        status:
          response.result.code === 'INDETERMINATE' ? 'unconfirmed' : 'not_sent',
        previous: prepared.sample.value,
        requested: prepared.target,
        observed: current === -Infinity ? '-inf' : (current ?? null),
      },
      ...(observation?.status === 'unconfirmed'
        ? {
            result: {
              ...response.result,
              ok: false,
              message:
                'Não confirmado: confira o envio antes de nova operação. Não houve repetição automática.',
              data: { ...response.result.data, confirmation: observation },
            },
          }
        : {}),
    };
  }
}

const services = new WeakMap<ServerCore, FirstRealAuxService>();
export function realControlsFor(core: ServerCore): FirstRealAuxService {
  let service = services.get(core);
  if (!service) { service = new FirstRealAuxService(core); services.set(core, service); }
  return service;
}

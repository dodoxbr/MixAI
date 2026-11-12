import { createHash, randomBytes } from 'node:crypto';
import { ProposalBuilder, type Proposal } from '../../assistant/proposals.js';
import type { Intent } from '../../assistant/intent.js';
import type { ParamKey } from '../../core/revisions.js';
import { Ui16RealBridge } from '../../mixer/ui16-real-bridge.js';
import { isAuxLevel, type AuxObservation } from '../../mixer/ui16-aux-write.js';
import type { Principal } from '../auth.js';
import { fail, type ServerCore, type CommandResponse } from '../core.js';

interface Prepared {
  proposal: Proposal;
  key: ParamKey;
  sample: AuxObservation;
  target: number;
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
        'Só uma sessão autenticada de operador pode autorizar AUX REAL.',
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
        'Escrita AUX desabilitada ou sem identificação/conexão/rota válidas.',
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
    const available = !!bridge?.auxHandshake.available();
    let observed: number | '-inf' | null = null;
    const registered =
      Number.isInteger(query.channel) && Number.isInteger(query.aux) &&
      names.inputs.configured().includes(query.channel!) && names.aux.configured().includes(query.aux!);
    if (registered && bridge) {
      const sample = bridge.auxHandshake.current(`ch.${query.channel}.aux.${query.aux}.level` as ParamKey);
      if (sample) observed = sample.value === -Infinity ? '-inf' : sample.value;
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
    const names = this.core.controller.names;
    let intent: Intent;
    if (input.undo === true) {
      const undo = this.core.controller.peekUndo();
      if (!undo || undo.keys.length !== 1 || !isAuxLevel(undo.keys[0]!))
        return {
          result: fail(
            'INVALID',
            'Desfazer exige um único envio AUX autorizado.',
          ),
        };
      intent = { type: 'undo' };
    } else {
      if (
        !Number.isInteger(input.channel) ||
        !names.inputs.configured().includes(input.channel!) ||
        !Number.isInteger(input.aux) ||
        !names.aux.configured().includes(input.aux!) ||
        !Number.isFinite(input.deltaDB) ||
        Math.abs(input.deltaDB!) > 1 ||
        input.deltaDB === 0
      )
        return {
          result: fail(
            'INVALID',
            'Selecione um canal/AUX cadastrado e passo de até 1 dB.',
          ),
        };
      intent = {
        type: 'level',
        channel: input.channel!,
        dest: 'fones',
        aux: input.aux!,
        deltaDB: input.deltaDB!,
      };
    }
    const built = this.builder.build(p, intent, 'local');
    if (!built.ok) return { result: fail('INVALID', built.message) };
    const pr = built.proposal;
    const parameters = pr.card.parameters;
    if (
      !parameters ||
      parameters.length !== 1 ||
      !isAuxLevel(parameters[0]!.key)
    )
      return {
        result: fail(
          'INVALID',
          'Somente um fader de envio AUX pode ser autorizado.',
        ),
      };
    const { key, previous, target } = parameters[0]!;
    const match = /^ch\.(\d+)\.aux\.(\d+)\.level$/.exec(key)!;
    if (
      !names.inputs.configured().includes(Number(match[1])) ||
      !names.aux.configured().includes(Number(match[2])) ||
      typeof previous !== 'number' ||
      typeof target !== 'number' ||
      !Number.isFinite(previous) ||
      !Number.isFinite(target) ||
      Math.abs(target - previous) >
        Math.min(1, this.core.controller.limits().maxStepDB) ||
      target === previous
    )
      return {
        result: fail(
          'INVALID',
          'Origem/alvo fora do escopo de até 1 dB. Nada autorizado.',
        ),
      };
    const sample = this.bridge()!.auxHandshake.current(key);
    if (!sample || Math.abs(sample.value - previous) > 0.05)
      return {
        result: fail(
          'STATE_CHANGED',
          'Leitura atual indisponível, antiga ou diferente; obtenha nova observação.',
        ),
      };
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
      'REAL: confirmação humana de uma operação AUX de até 1 dB. AUX1/HA800 é compartilhado. Não é uma medição de áudio.';
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
      validation: this.bridge()!.auxHandshake.gate!.validation,
    };
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
      bridge.auxHandshake.available();
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

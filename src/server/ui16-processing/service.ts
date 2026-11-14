import { createHash, randomBytes } from 'node:crypto';
import type { ParamKey, ParamValue } from '../../core/revisions.js';
import { Ui16RealBridge } from '../../mixer/ui16-real-bridge.js';
import type { AuxObservation } from '../../mixer/ui16-aux-write.js';
import {
  processingCapabilities,
  processingSpec,
  validProcessingChange,
} from '../../mixer/ui16-processing.js';
import type { Principal } from '../auth.js';
import { fail, type ServerCore, type CommandResponse } from '../core.js';
import type { Intent } from '../../assistant/intent.js';
import type { ProposalCard } from '../../assistant/proposals.js';

export interface ProcessingProposal {
  id: string;
  source: 'operator' | 'assistant';
  channel: number;
  channelName: string;
  scope: 'input_channel_processing_not_destination_specific';
  key: ParamKey;
  unit: 'boolean' | 'dB' | 'Q' | 'Hz';
  previous: ParamValue;
  target: ParamValue;
  reverse: { key: ParamKey; value: ParamValue };
  revision: number;
  expiresAt: string;
  requiresHumanConfirmation: true;
  basis: 'observed_parameter_not_acoustic_measurement';
  warnings: string[];
}
interface Prepared {
  owner: string;
  proposal: ProcessingProposal;
  sample: AuxObservation<ParamValue>;
  undoId?: number;
  consumed?: { requestId: string; response: Promise<unknown>; completed?: boolean };
  cancelled?: boolean;
}
export interface ConfirmProcessing {
  targetMode: unknown;
  serverId: unknown;
  requestId: string;
  humanConfirmed: unknown;
}
/** Same server authentication + queued authorization + socket handshake as #100. No second executor. */
export class Ui16ProcessingService {
  private proposals = new Map<string, Prepared>();
  private locks = new Set<ParamKey>();
  constructor(
    private core: ServerCore,
    private now = () => Date.now(),
  ) {
    core.auth.onRevoke((id) => {
      for (const p of this.proposals.values()) if (p.owner === id) p.cancelled = true;
    });
  }
  private bridge() {
    return this.core.mode === 'real' && this.core.mixer instanceof Ui16RealBridge
      ? this.core.mixer
      : undefined;
  }
  private access(p: Principal, mode: unknown, serverId: unknown, writing = true) {
    if (p.role !== 'operator' || !this.core.auth.isActive(p))
      return fail('FORBIDDEN', 'Processamento exige sessão ativa de operador.');
    if (mode !== 'real' || !this.bridge())
      return fail(
        'MODE_MISMATCH',
        'Modo REAL explícito obrigatório; transporte físico permanece bloqueado por padrão.',
      );
    if (serverId !== this.core.serverId)
      return fail('SERVER_CHANGED', 'Instância do servidor mudou.');
    if (writing && !this.bridge()!.processingHandshake.available())
      return fail(
        'DEGRADED_READ_ONLY',
        'Gate de processamento fechado ou identificação/conexão/rota indisponível.',
      );
    return undefined;
  }
  state(p: Principal, channel: number) {
    const blocked = this.access(p, 'real', this.core.serverId, false);
    if (blocked) return { result: blocked };
    if (
      !Number.isInteger(channel) ||
      !this.core.controller.names.inputs.configured().includes(channel)
    )
      return { result: fail('INVALID', 'Canal não cadastrado.') };
    const keys: ParamKey[] = [];
    for (const band of [1, 2, 3, 4] as const)
      for (const field of ['freq', 'gain', 'q'] as const)
        keys.push(`ch.${channel}.eq.b${band}.${field}`);
    keys.push(`ch.${channel}.eq.hpf.freq`, `ch.${channel}.eq.bypass`);
    const parameters = Object.fromEntries(
      keys.map((key) => [
        key,
        {
          ...this.bridge()!.processingReading(key),
          display: this.bridge()!.processingDisplayReading(key),
        },
      ]),
    );
    const hpf = parameters[`ch.${channel}.eq.hpf.freq`]!;
    return {
      schemaVersion: 1,
      serverId: this.core.serverId,
      channel,
      connection: {
        generation: this.bridge()!.supervisor.generation(),
        link: this.bridge()!.link(),
      },
      capabilities: processingCapabilities,
      physicalWriteEnabled: this.bridge()!.processingHandshake.enabled(),
      physicalWriteAvailable: this.bridge()!.processingHandshake.available(),
      parameters,
      hpfBypass:
        hpf.state === 'confirmed'
          ? { state: 'derived', value: hpf.rawValue === 0, basis: 'frequency_20_hz' }
          : { state: 'unavailable' },
      scope: 'input_channel_processing_not_destination_specific',
    };
  }
  preview(
    p: Principal,
    input: {
      targetMode: unknown;
      serverId: unknown;
      key?: string;
      value?: ParamValue;
      source?: 'operator' | 'assistant';
      undo?: boolean;
    },
  ) {
    const blocked = this.access(p, input.targetMode, input.serverId);
    if (blocked) return { result: blocked };
    let key = input.key,
      target = input.value,
      undoId: number | undefined;
    if (input.undo === true) {
      const undo = this.core.controller.peekUndo();
      if (!undo || undo.targets.length !== 1 || !processingSpec(undo.targets[0]!.key))
        return {
          result: fail(
            'INVALID',
            'Desfazer exige o último ajuste de um único parâmetro de processamento.',
          ),
        };
      key = undo.targets[0]!.key;
      target = undo.targets[0]!.before;
      undoId = undo.id;
    }
    const spec = key && processingSpec(key);
    if (
      !spec ||
      !this.core.controller.names.inputs.configured().includes(spec.channel) ||
      target === undefined
    )
      return { result: fail('INVALID', 'Parâmetro, alvo ou canal indisponível.') };
    const sample = this.bridge()!.processingHandshake.current(spec.key);
    if (!sample)
      return {
        result: fail(
          'STATE_CHANGED',
          'Leitura independente ausente, antiga, estéreo ou indisponível.',
        ),
      };
    if (!validProcessingChange(spec.key, sample.value, target))
      return {
        result: fail('INVALID', 'Limites de ganho/frequência/Q, passo ou reversão não atendidos.'),
      };
    const revision = this.core.controller.state.snapshot([spec.key]).params[spec.key]!.revision;
    for (const [id, old] of this.proposals)
      if (
        (!old.consumed || old.consumed.completed) &&
        this.now() > Date.parse(old.proposal.expiresAt) + 60000
      )
        this.proposals.delete(id);
    if (this.proposals.size >= 100)
      return { result: fail('RATE_LIMIT', 'Limite de propostas atingido.') };
    const proposal: ProcessingProposal = {
      id: randomBytes(6).toString('hex'),
      source: input.source ?? 'operator',
      channel: spec.channel,
      channelName: this.core.controller.names.inputs.nameOf(spec.channel),
      scope: spec.scope,
      key: spec.key,
      unit: spec.unit,
      previous: sample.value,
      target,
      reverse: { key: spec.key, value: sample.value },
      revision,
      expiresAt: new Date(this.now() + 15000).toISOString(),
      requiresHumanConfirmation: true,
      basis: 'observed_parameter_not_acoustic_measurement',
      warnings: [
        'Processamento do canal de entrada, sem destino PA/AUX independente. O efeito nos retornos depende do roteamento não verificado. AUX1/HA800 é compartilhado.',
      ],
    };
    this.proposals.set(proposal.id, { owner: p.id, proposal, sample: { ...sample }, undoId });
    this.core.audit(p, 'processing_preview', 'Prévia de um parâmetro; nenhuma escrita.', {
      id: proposal.id,
      key: spec.key,
      unit: spec.unit,
      previous: sample.value,
      target,
      source: proposal.source,
    });
    return {
      proposal: structuredClone(proposal),
      causalAcknowledgement: false,
      validation: this.bridge()!.processingHandshake.gate!.validation,
    };
  }
  /**
   * Fronteira do assistente: uma intenção tipada (EQ/HPF/bypass ou desfazer) vira SOMENTE uma prévia pelo mesmo caminho do operador.
   * Calcula o alvo relativo de ganho a partir da amostra independente; não escreve, não confirma e não aceita comando bruto.
   */
  previewIntent(p: Principal, intent: Intent, source: ProposalCard['source']): { proposal?: ProposalCard; result?: { code: string; message: string } } {
    const common = { targetMode: 'real', serverId: this.core.serverId, source: 'assistant' as const };
    let out: ReturnType<Ui16ProcessingService['preview']>;
    if (intent.type === 'undo') out = this.preview(p, { ...common, undo: true });
    else if (intent.type === 'processing') {
      const key = (intent.field === 'hpf' ? `ch.${intent.channel}.eq.hpf.freq` : intent.field === 'bypass' ? `ch.${intent.channel}.eq.bypass` : `ch.${intent.channel}.eq.b${intent.band}.${intent.field}`) as ParamKey;
      let value = intent.value;
      if (value === undefined && intent.deltaDB !== undefined && intent.field === 'gain') {
        const current = processingSpec(key) && this.bridge()?.processingHandshake.current(key)?.value;
        if (typeof current !== 'number') return { result: { code: 'STATE_CHANGED', message: 'Leitura independente ausente, antiga ou indisponível: não calculo o ganho sem o valor atual.' } };
        value = Number((current + intent.deltaDB).toFixed(1));
      }
      if (value === undefined) return { result: { code: 'INVALID', message: 'Falta o valor do ajuste.' } };
      out = this.preview(p, { ...common, key, value });
    } else return { result: { code: 'INVALID', message: 'Intenção fora do escopo do processamento.' } };
    if (!('proposal' in out) || !out.proposal) { const r = (out as { result: { code: string; message: string } }).result; return { result: { code: r.code, message: r.message } }; }
    const pr = out.proposal, spec = processingSpec(pr.key)!;
    const show = (v: ParamValue) => typeof v === 'boolean' ? (v ? 'bypass ligado (EQ fora do caminho)' : 'bypass desligado (EQ ativo)') : spec.unit === 'dB' ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB` : spec.unit === 'Q' ? `Q ${v}` : `${v} Hz`;
    const what = spec.field === 'hpf' ? 'HPF · frequência de corte' : spec.field === 'bypass' ? 'EQ · bypass' : `EQ banda ${spec.band} · ${spec.field === 'freq' ? 'frequência' : spec.field === 'gain' ? 'ganho' : 'Q'}`;
    const undo = intent.type === 'undo';
    const card: ProposalCard = {
      id: pr.id, source, title: undo ? `Desfazer: ${what}` : what, channel: pr.channelName, destination: undo ? 'DESFAZER' : 'CANAL',
      parameters: [{ key: pr.key, previous: pr.previous, target: pr.target, revision: pr.revision }],
      current: show(pr.previous), change: undo ? 'desfazer (nova confirmação)' : `${show(pr.previous)} → ${show(pr.target)}`, result: show(pr.target),
      reason: `REAL: processamento do canal de entrada (sem destino PA/AUX). ${pr.warnings[0] ?? ''} Observação do parâmetro, não medição de áudio.`,
      needsApproval: true, expiresAt: pr.expiresAt,
      realControl: { targetMode: 'real', serverId: this.core.serverId, category: 'processing', confirmationPath: `/api/ui16/processing/${pr.id}/confirm`, cancelPath: `/api/ui16/processing/${pr.id}/cancel`,
        observed: typeof pr.previous === 'number' || typeof pr.previous === 'boolean' ? pr.previous : null, validation: out.validation, unit: spec.unit },
    };
    return { proposal: card };
  }
  cancel(p: Principal, id: string) {
    const item = this.proposals.get(id);
    if (!this.core.auth.isActive(p) || p.role !== 'operator' || !item || item.owner !== p.id)
      return { result: fail('NOT_FOUND', 'Proposta não encontrada nesta sessão.') };
    if (item.consumed)
      return { result: fail('CONFLICT', 'Confirmação já consumida; não há rollback automático.') };
    item.cancelled = true;
    this.core.audit(p, 'processing_cancel', 'Proposta cancelada sem escrita.', { id });
    return { result: { ok: true, code: 'OK', message: 'Proposta cancelada.' } };
  }
  confirm(p: Principal, id: string, input: ConfirmProcessing): Promise<unknown> {
    const blocked = this.access(p, input.targetMode, input.serverId);
    if (blocked) return Promise.resolve({ result: blocked });
    if (input.humanConfirmed !== true || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.requestId))
      return Promise.resolve({
        result: fail('FORBIDDEN', 'Confirmação humana e requestId obrigatórios.'),
      });
    const item = this.proposals.get(id);
    if (!item || item.owner !== p.id || item.cancelled)
      return Promise.resolve({
        result: fail('NOT_FOUND', 'Proposta não encontrada nesta sessão.'),
      });
    if (item.consumed)
      return item.consumed.requestId === input.requestId
        ? item.consumed.response
        : Promise.resolve({ result: fail('CONFIRMATION_USED', 'Autorização já consumida.') });
    if (this.now() > Date.parse(item.proposal.expiresAt))
      return Promise.resolve({ result: fail('CONFIRMATION_EXPIRED', 'Faça nova prévia.') });
    if (this.locks.has(item.proposal.key))
      return Promise.resolve({ result: fail('CONFLICT', 'Parâmetro em andamento.') });
    this.locks.add(item.proposal.key);
    // Defer until the promise is registered, so even synchronous re-entry cannot duplicate a write.
    const response = Promise.resolve()
      .then(() => this.execute(p, item, input))
      .finally(() => {
        this.locks.delete(item.proposal.key);
        if (item.consumed) item.consumed.completed = true;
      });
    item.consumed = { requestId: input.requestId, response };
    return response;
  }
  private async execute(p: Principal, item: Prepared, input: ConfirmProcessing) {
    const bridge = this.bridge()!,
      pr = item.proposal,
      operationId = randomBytes(12).toString('hex');
    const authorized = () =>
      this.core.auth.isActive(p) &&
      p.role === 'operator' &&
      !item.cancelled &&
      this.now() <= Date.parse(pr.expiresAt) &&
      this.bridge() === bridge &&
      bridge.processingHandshake.available();
    let response: CommandResponse;
    try {
      response = await this.core.execute(
        p,
        {
          requestId:
            'processing:' +
            createHash('sha256')
              .update(pr.id + ':' + input.requestId)
              .digest('hex')
              .slice(0, 48),
          targetMode: 'real',
          serverId: input.serverId,
          command:
            item.undoId === undefined
              ? { type: 'set_processing', key: pr.key, value: pr.target }
              : { type: 'undo', steps: 1 },
        },
        {
          expect: {
            revisions: [[pr.key, pr.revision]],
            undoId: item.undoId,
            authorize: () => {
              if (!authorized()) return false;
              try {
                bridge.processingHandshake.authorize({
                  id: operationId,
                  key: pr.key,
                  previous: item.sample,
                  requested: pr.target,
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
        result: fail('INDETERMINATE', 'Resultado indeterminado. Não repita automaticamente.'),
      };
    } finally {
      bridge.processingHandshake.cancelAuthorization(operationId);
    }
    const confirmation = bridge.processingHandshake.report(operationId) ?? {
      status: response.result.code === 'INDETERMINATE' ? 'unconfirmed' : 'not_sent',
      previous: pr.previous,
      requested: pr.target,
      observed: null,
      causalAcknowledgement: false,
    };
    if (response.result.ok && confirmation.status !== 'observed_target')
      response = {
        ...response,
        result: fail('STATE_CHANGED', 'Resultado não confirmado; confira o estado.'),
      };
    this.core.audit(p, 'processing_confirmation', 'Retorno da operação de processamento.', {
      id: pr.id,
      key: pr.key,
      status: confirmation.status,
    });
    return { ...response, requestId: input.requestId, confirmation };
  }
}

const processingServices = new WeakMap<ServerCore, Ui16ProcessingService>();
/** Uma única instância por núcleo, compartilhada entre as rotas HTTP e o assistente (mesmos bloqueios e propostas). */
export function processingFor(core: ServerCore): Ui16ProcessingService {
  let service = processingServices.get(core);
  if (!service) { service = new Ui16ProcessingService(core); processingServices.set(core, service); }
  return service;
}

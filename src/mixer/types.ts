import type { ParamKey, ParamValue } from '../core/revisions.js';

/** Onde um ajuste acontece: na mix principal (master) ou num retorno (AUX). */
export type Bus = { kind: 'master' } | { kind: 'aux'; aux: number };

export const MASTER: Bus = { kind: 'master' };
export const auxBus = (aux: number): Bus => ({ kind: 'aux', aux });

export interface MixerCapabilities {
  model: string;
  inputs: number;
  aux: number;
}

export type ShowList = Record<string, string[]>;

/**
 * Estado da ligação com a mesa.
 * - READY: leitura e escrita.
 * - DEGRADED_READ_ONLY: sincronização incompleta; leitura parcial, escrita bloqueada.
 * - CONNECTING / SYNCING / LOST: sem leitura nem escrita (LOST = nova tentativa agendada).
 * - STOPPED: controle automático interrompido (falha interna); usar a interface oficial.
 */
export type LinkState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'SYNCING'
  | 'DEGRADED_READ_ONLY'
  | 'READY'
  | 'LOST'
  | 'STOPPED';

export type ReadResult = { known: true; value: ParamValue } | { known: false };

/** O que se sabe sobre uma escrita no momento em que ela termina. */
export type WriteOutcome = 'sent' | 'applied_simulated';

/** Classificação de uma escrita feita perto de uma queda, depois da ressincronização. */
export type VerificationOutcome = 'observed_target' | 'observed_different' | 'indeterminate';

export interface VerificationReport {
  key: ParamKey;
  target: ParamValue;
  observed?: ParamValue;
  outcome: VerificationOutcome;
}

export type ParamChangeOrigin = 'external' | 'resync';

/** Escrita recusada porque a ligação não está em READY. Nada foi enviado. */
export class LinkUnavailableError extends Error {
  constructor(readonly link: LinkState) {
    super(`Ligação com a mesa em ${link}`);
  }
}

/**
 * Contrato único para a mesa real e a simulada.
 * Leituras são síncronas (vêm do estado espelhado); escritas só acontecem em READY.
 */
export interface MixerAdapter {
  /** mock = dublê em memória (testes); lab = laboratório persistente; real = Ui16 física. */
  readonly mode: 'mock' | 'lab' | 'real';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  link(): LinkState;
  statusText(): string;
  capabilities(): MixerCapabilities;

  read(key: ParamKey): ReadResult;
  /** Lança LinkUnavailableError se não estiver em READY; nesse caso nada foi enviado. */
  write(key: ParamKey, value: ParamValue): Promise<WriteOutcome>;

  /** Mudanças vindas de fora (outro aparelho, interface oficial) ou da ressincronização. */
  onParamChange(listener: (key: ParamKey, value: ParamValue, origin: ParamChangeOrigin) => void): () => void;
  /** Resultado das escritas feitas na janela de uma queda, depois da ressincronização. */
  onVerification(listener: (reports: VerificationReport[]) => void): () => void;
  /** Mudanças no estado da ligação (READY, LOST, ...). */
  onLinkChange(listener: (state: LinkState) => void): () => void;

  /** Nome escrito no canal da própria mesa, se conhecido. */
  channelName(channel: number): string | undefined;

  listShows(): Promise<ShowList>;
  currentSnapshot(): Promise<{ show?: string; snapshot?: string }>;
  /** Lança LinkUnavailableError se não estiver em READY. */
  loadSnapshot(show: string, snapshot: string): Promise<WriteOutcome>;
  /** Grava imediatamente o estado pendente (só o laboratório persiste). */
  flush?(): void;
}

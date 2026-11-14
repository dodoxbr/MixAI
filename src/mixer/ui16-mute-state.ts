/**
 * MUTE efetivo da Ui16 (somente leitura): separa MUTE individual, Mute All, Force Unmute e o resultado.
 *
 * Evidência física (leitura crua, 2026-11-14): `mgmask` global = 8388608 (bit 23); `i.N.mute` individual; `i.N.forceunmute`.
 * Evidência do código (soundcraft-ui-connection 7.1.0): `muteGroup('all')` usa o bit 23 de `mgmask`; grupos 1..6 = bits 0..5, FX = bit 22.
 * NÃO validado fisicamente (portanto nunca presumido aqui): a precedência de Force Unmute sobre o MUTE individual e sobre os grupos.
 * Onde essa regra decidiria o resultado, o estado efetivo é `unknown` com a causa pendente. Pura, sem E/S, sem escrita.
 */
export const MUTE_ALL_BIT = 1 << 23;
export const MUTE_GROUP_MASK_BITS = 24;
export const MUTE_GROUP_MASK_MAX = (1 << MUTE_GROUP_MASK_BITS) - 1;

/** Um fato observado na conexão ATUAL, ou a razão pela qual não existe (nunca um valor padrão). */
export type Fact<T> = { state: 'confirmed'; value: T } | { state: 'unknown'; reason: FactReason };
export type FactReason =
  | 'not_observed'
  | 'disconnected'
  | 'inbound_silence'
  | 'invalid_sample'
  | 'unsupported'
  | 'write_pending';

export type MuteCause =
  | 'none'
  | 'individual'
  | 'mute_all'
  | 'individual_and_mute_all'
  | 'force_unmute_precedence_pending'
  | 'other_mute_group_membership_unvalidated'
  | 'group_state_unavailable'
  | 'individual_unavailable'
  | 'force_unmute_unavailable';

export interface EffectiveMute {
  channel: number;
  individual: boolean | null;
  muteAll: 'active' | 'inactive' | 'unknown';
  otherGroupsActive: boolean | null;
  forceUnmute: boolean | null;
  effective: 'muted' | 'open' | 'unknown';
  cause: MuteCause;
  /** `pending`: a regra do firmware que decidiria este caso ainda depende de validação física. */
  precedence: 'not_needed' | 'pending';
  reasons: FactReason[];
}

const known = <T>(f: Fact<T>): f is { state: 'confirmed'; value: T } => f.state === 'confirmed';

export function groupFlags(mask: Fact<number>): { muteAll: EffectiveMute['muteAll']; other: boolean | null } {
  if (!known(mask)) return { muteAll: 'unknown', other: null };
  return { muteAll: (mask.value & MUTE_ALL_BIT) !== 0 ? 'active' : 'inactive', other: (mask.value & ~MUTE_ALL_BIT & MUTE_GROUP_MASK_MAX) !== 0 };
}

/**
 * Tabela de decisão (I = individual, A = Mute All, O = outros grupos ativos, F = Force Unmute):
 *  - Fatos ausentes nunca viram "aberto": sem evidência suficiente o resultado é `unknown`.
 *  - F=1 em combinação com qualquer grupo ativo, ou F=1 com I=mudo: precedência pendente → `unknown`.
 *  - Outro grupo (1..6/FX) ativo: a pertinência do canal ao grupo não foi validada → só `muted` se I=mudo e F=0; senão `unknown`.
 *  - Mute All ativo e F=0: silenciado (cause mute_all, ou individual_and_mute_all).
 *  - Sem grupo ativo: efetivo = individual (F=0/desconhecido não muda um canal já aberto).
 */
export function effectiveMute(input: { channel: number; individual: Fact<boolean>; groups: Fact<number>; forceUnmute: Fact<boolean> }): EffectiveMute {
  const { channel } = input;
  const I = known(input.individual) ? input.individual.value : null;
  const F = known(input.forceUnmute) ? input.forceUnmute.value : null;
  const { muteAll, other } = groupFlags(input.groups);
  const reasons: FactReason[] = [];
  for (const fact of [input.individual, input.groups, input.forceUnmute] as Array<Fact<unknown>>) if (fact.state === 'unknown') reasons.push(fact.reason);
  const out = (effective: EffectiveMute['effective'], cause: MuteCause, precedence: EffectiveMute['precedence'] = 'not_needed'): EffectiveMute => ({
    channel, individual: I, muteAll, otherGroupsActive: other, forceUnmute: F, effective, cause, precedence, reasons: [...new Set(reasons)],
  });

  // Grupos desconhecidos: só um MUTE individual com Force Unmute desligado é conclusivo.
  if (muteAll === 'unknown') {
    if (I === true && F === false) return out('muted', 'individual');
    return out('unknown', 'group_state_unavailable');
  }
  const groupActive = muteAll === 'active' || other === true;
  if (F === true && (groupActive || I === true)) return out('unknown', 'force_unmute_precedence_pending', 'pending');
  if (other === true) return I === true && F === false ? out('muted', 'individual') : out('unknown', 'other_mute_group_membership_unvalidated');
  if (muteAll === 'active') {
    if (F === false) return out('muted', I === true ? 'individual_and_mute_all' : 'mute_all');
    return out('unknown', 'force_unmute_unavailable');
  }
  // nenhum grupo ativo
  if (I === null) return out('unknown', 'individual_unavailable');
  if (I === false) return out('open', 'none');
  return F === false ? out('muted', 'individual') : out('unknown', 'force_unmute_unavailable');
}

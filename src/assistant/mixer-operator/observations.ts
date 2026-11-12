import type { ServerCore } from '../../server/core.js';
import type { Principal } from '../../server/auth.js';
import { paramKey, type ParamKey } from '../../core/revisions.js';
import { encodeValue } from '../../core/state.js';
import { auxBus, MASTER } from '../../mixer/types.js';
import type { OperatorObservations } from './contracts.js';
/** Uses the existing visibility projection and parameter registry; never probes hardware or invents support. */
export function operatorObservations(core: ServerCore, actor: Principal, channel: number, dest: 'pa' | 'fones', aux?: number): OperatorObservations | undefined {
  const bus = dest === 'pa' ? MASTER : auxBus(aux ?? core.policy.musicianAux);
  const level = paramKey.level(channel, bus), mute = paramKey.mute(channel, bus), visible = core.snapshotFor(actor).params;
  if (!Object.hasOwn(visible, level) || !Object.hasOwn(visible, mute)) return undefined;
  const keys: ParamKey[] = [level, mute];
  if (actor.role === 'operator') keys.push(...core.controller.registry.keys().filter(key => key.startsWith(`ch.${channel}.eq.`)));
  const snapshot = core.controller.state.snapshot(keys);
  return { schemaVersion: 1, mode: core.mode, link: snapshot.link, revision: snapshot.revision, channel,
    destination: bus.kind === 'master' ? 'PA' : `AUX${bus.aux}`,
    parameters: keys.map(key => {
      const spec = core.controller.registry.get(key), state = snapshot.params[key];
      if (!spec || (core.mode === 'real' && spec.capability === 'simulated_only')) return { key, status: 'unsupported', revision: state?.revision ?? 0, capability: spec?.capability ?? 'unsupported' };
      return { key, status: state.value.status, ...(state.value.status === 'known' ? { value: encodeValue(state.value.value) } : {}), revision: state.revision, capability: spec.capability };
    }),
    unavailable: ['preamp_gain', 'phantom', 'hardware_routing', 'AFS2', 'compressor', 'gate', 'audio_spectrum', 'acoustic_SPL'],
    limitations: [core.mode === 'real' ? 'Leituras disponíveis não comprovam ganho, EQ, HPF ou roteamento não integrados ao adaptador.' : 'Estado LAB/MOCK simulado: não é áudio, configuração de fábrica ou medição da mesa física.',
      'Fader/MUTE e EQ não comprovam falta de grave, microfonia ou qualidade acústica. Hipóteses e relato continuam separados.',
      'Verificar fonte/destino e MUTE; conferir HPF/EQ apenas quando disponíveis; ganho/roteamento exigem inspeção manual. Não aplicar correção especulativa.'],
  };
}

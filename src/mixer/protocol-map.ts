import type { SoundcraftUI } from 'soundcraft-ui-connection';
import { parseKey, type ParamKey, type ParamValue } from '../core/revisions.js';

interface Subscribable<T> {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
}

// Único lugar que conhece a API da biblioteca para cada parâmetro do MixAI.
// EQ/HPF/bypass já existem no modelo (E1), mas só são traduzidos aqui quando forem
// verificados na mesa física; até lá, qualquer tentativa é recusada explicitamente.

/** Parâmetros que ainda não são enviados à mesa real (EQ/HPF chegam numa etapa futura). */
export class UnsupportedOnRealMixerError extends Error {
  constructor(key: ParamKey) {
    super(`O parâmetro ${key} ainda não é suportado na mesa real (somente laboratório).`);
  }
}

export function observeParam(ui: SoundcraftUI, key: ParamKey): Subscribable<ParamValue> {
  const p = parseKey(key);
  if (p.kind === 'master') return ui.master.faderLevelDB$;
  if (p.kind !== 'channel') throw new UnsupportedOnRealMixerError(key);
  const ch = p.aux ? ui.aux(p.aux).input(p.channel) : ui.master.input(p.channel);
  return p.param === 'level' ? ch.faderLevelDB$ : ch.mute$;
}

export function writeParam(ui: SoundcraftUI, key: ParamKey, value: ParamValue): void {
  const p = parseKey(key);
  if (p.kind === 'master') {
    ui.master.setFaderLevelDB(value as number);
    return;
  }
  if (p.kind !== 'channel') throw new UnsupportedOnRealMixerError(key);
  const ch = p.aux ? ui.aux(p.aux).input(p.channel) : ui.master.input(p.channel);
  if (p.param === 'level') ch.setFaderLevelDB(value as number);
  else ch.setMute(value as boolean);
}

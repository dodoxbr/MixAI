import type { SoundcraftUI } from 'soundcraft-ui-connection';
import { parseKey, type ParamKey, type ParamValue } from '../core/revisions.js';

interface Subscribable<T> {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
}

/**
 * Único lugar que conhece a API da biblioteca para cada parâmetro do MixAI.
 * Quando a E1 ampliar os parâmetros (EQ/HPF), as traduções entram aqui.
 */
export function observeParam(ui: SoundcraftUI, key: ParamKey): Subscribable<ParamValue> {
  const p = parseKey(key);
  if (p.kind === 'master') return ui.master.faderLevelDB$;
  const ch = p.aux ? ui.aux(p.aux).input(p.channel) : ui.master.input(p.channel);
  return p.param === 'level' ? ch.faderLevelDB$ : ch.mute$;
}

export function writeParam(ui: SoundcraftUI, key: ParamKey, value: ParamValue): void {
  const p = parseKey(key);
  if (p.kind === 'master') {
    ui.master.setFaderLevelDB(value as number);
    return;
  }
  const ch = p.aux ? ui.aux(p.aux).input(p.channel) : ui.master.input(p.channel);
  if (p.param === 'level') ch.setFaderLevelDB(value as number);
  else ch.setMute(value as boolean);
}

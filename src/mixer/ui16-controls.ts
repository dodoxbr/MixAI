import { DBToFaderValue } from 'soundcraft-ui-connection';
import type { ParamKey, ParamValue } from '../core/revisions.js';
import type { FirstRealAuxGate } from './ui16-aux-write.js';

export const UI16_CONTROL_CATEGORIES = ['pa_level', 'pa_mute', 'aux_level', 'aux_mute', 'master_level'] as const;
export type Ui16ControlCategory = typeof UI16_CONTROL_CATEGORIES[number];
/** Trusted bootstrap only. The master approval flow is reserved, not enabled in this version. */
export type Ui16ControlGates = Partial<Record<Exclude<Ui16ControlCategory, 'master_level'>, FirstRealAuxGate>> & {
  master_level?: { enabled: false };
};
export function controlCategory(key: ParamKey): Ui16ControlCategory | undefined {
  if (key === 'master.level') return 'master_level';
  const match = /^ch\.([1-9]\d*)\.(main|aux\.([1-9]\d*))\.(level|mute)$/.exec(key);
  return match ? `${match[3] ? 'aux' : 'pa'}_${match[4]}` as Ui16ControlCategory : undefined;
}
export function controlPath(key: ParamKey): string | undefined {
  if (key === 'master.level') return 'm.mix';
  const match = /^ch\.([1-9]\d*)\.(main|aux\.([1-9]\d*))\.(level|mute)$/.exec(key);
  if (!match) return undefined;
  return `i.${Number(match[1]) - 1}.${match[3] ? `aux.${Number(match[3]) - 1}.${match[4] === 'level' ? 'value' : 'mute'}` : match[4] === 'level' ? 'mix' : 'mute'}`;
}
/** Exact library 7.1.0 frame. No master write, arbitrary path or batch. */
export function controlFrame(key: ParamKey, value: ParamValue): string | undefined {
  const category = controlCategory(key), path = controlPath(key);
  if (!category || category === 'master_level' || !path) return undefined;
  if (category.endsWith('mute')) return typeof value === 'boolean' ? `3:::SETD^${path}^${Number(value)}` : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? `3:::SETD^${path}^${DBToFaderValue(value)}` : undefined;
}
export function validControlChange(key: ParamKey, previous: ParamValue, requested: ParamValue): boolean {
  const category = controlCategory(key);
  if (!category || category === 'master_level') return false;
  if (category.endsWith('mute')) return typeof previous === 'boolean' && typeof requested === 'boolean' && previous !== requested;
  return typeof previous === 'number' && typeof requested === 'number' && Number.isFinite(previous) && Number.isFinite(requested) && Math.abs(previous - requested) <= 1 && previous !== requested;
}

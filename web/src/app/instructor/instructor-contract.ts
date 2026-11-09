/** Read-only presentation boundary for C (#65); deliberately cannot express mixer actions. */
export interface InstructionOrigin { title: string; url: string; locator: string; version: string }
export interface InstructionStep {
  id: string; control: string; action: string; expected: string; alternative: string; caution: string;
  /** Labels only. A diagram never represents a verified official screenshot. */
  schematic: string[];
}
export interface Ui16Procedure {
  id: string; title: string; purpose: string; preconditions: string[];
  scope: 'lab_instruction'; version: string; validation: 'fixture' | 'documented' | 'theory';
  interfaceLimit: string; origin: InstructionOrigin; steps: InstructionStep[];
}
export interface InstructionCatalog { schemaVersion: 1; procedures: Ui16Procedure[] }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 8000;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 30 && v.every(string);
export function instructionUrl(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.href : null; } catch { return null; }
}
/** Reject malformed/unknown versions, duplicate IDs and unsafe links, instead of inventing steps. */
export function adaptInstructionCatalog(input: unknown): InstructionCatalog {
  const data = object(input);
  if (data['schemaVersion'] !== 1 || !Array.isArray(data['procedures']) || !data['procedures'].length || data['procedures'].length > 50) throw new Error('Catálogo de instruções incompatível.');
  const procedures = data['procedures'].map(value => {
    const p = object(value), origin = object(p['origin']);
    if (!['id','title','purpose','version','interfaceLimit'].every(k => string(p[k])) || !strings(p['preconditions']) || p['scope'] !== 'lab_instruction' || !['fixture','documented','theory'].includes(String(p['validation'])) || !['title','url','locator','version'].every(k => string(origin[k])) || !instructionUrl(String(origin['url'])) || !Array.isArray(p['steps']) || !p['steps'].length || p['steps'].length > 30) throw new Error('Procedimento incompatível.');
    const steps = p['steps'].map(value => {
      const s = object(value);
      if (!['id','control','action','expected','alternative','caution'].every(k => string(s[k])) || !strings(s['schematic'])) throw new Error('Etapa incompatível.');
      return { id: String(s['id']), control: String(s['control']), action: String(s['action']), expected: String(s['expected']), alternative: String(s['alternative']), caution: String(s['caution']), schematic: [...s['schematic']] };
    });
    if (new Set(steps.map(s => s.id)).size !== steps.length) throw new Error('Etapas duplicadas.');
    return { id: String(p['id']), title: String(p['title']), purpose: String(p['purpose']), preconditions: [...p['preconditions']], scope: 'lab_instruction' as const, version: String(p['version']), validation: p['validation'] as Ui16Procedure['validation'], interfaceLimit: String(p['interfaceLimit']), origin: { title: String(origin['title']), url: String(origin['url']), locator: String(origin['locator']), version: String(origin['version']) }, steps };
  });
  if (new Set(procedures.map(p => p.id)).size !== procedures.length) throw new Error('Procedimentos duplicados.');
  return { schemaVersion: 1, procedures };
}

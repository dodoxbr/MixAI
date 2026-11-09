import type { InstructionCatalog, InstructionStep, Ui16Procedure } from './instructor-contract';

/**
 * Fronteira entre a biblioteca técnica REAL do servidor (GET /api/instructor/procedures) e o Instrutor.
 * Somente leitura: o adaptador só devolve campos de apresentação e RECUSA qualquer procedimento que não declare
 * ser texto de estudo não executável. Nada aqui chama comando, mesa ou escrita.
 */
export type LibraryFailure = 'session' | 'forbidden' | 'unavailable' | 'incompatible' | 'empty';

export class InstructorLibraryError extends Error {
  constructor(readonly code: LibraryFailure) { super(code); }
}

export const LIBRARY_MESSAGES: Record<LibraryFailure, string> = {
  session: 'Sua sessão terminou. Entre novamente para abrir o instrutor.',
  forbidden: 'Este acesso não pode abrir o instrutor.',
  unavailable: 'Não foi possível carregar as instruções agora. Nenhuma operação foi executada. Tente novamente ou consulte o operador.',
  incompatible: 'As instruções recebidas não são compatíveis com esta versão da tela. Nenhuma operação foi executada. Consulte o operador.',
  empty: 'Não há procedimentos publicados no momento. Consulte o operador.',
};

export interface ServerCitation { title: string; url: string; section: string; version: string }
export interface ServerStep {
  id: string; control: string; instruction: string; verification: string; notFound: string; risks: string[];
  references: ServerCitation[];
}
export interface ServerProcedure {
  id: string; version: string; purpose: string; instruments: string[]; symptoms: string[];
  preconditions: string[]; steps: ServerStep[]; stop: string; references: ServerCitation[];
}
export interface ServerLibrary { schemaVersion: 1; libraryVersion: string; procedures: ServerProcedure[] }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 8000;
const texts = (v: unknown, min = 1): v is string[] => Array.isArray(v) && v.length >= min && v.length <= 30 && v.every(text);
const bad = (): never => { throw new InstructorLibraryError('incompatible'); };

function citation(value: unknown): ServerCitation {
  const c = rec(value);
  if (!text(c['title']) || !text(c['url']) || !text(c['section']) || !text(c['version'])) return bad();
  try { if (new URL(c['url'] as string).protocol !== 'https:') return bad(); } catch { return bad(); }
  return { title: c['title'] as string, url: c['url'] as string, section: c['section'] as string, version: c['version'] as string };
}

/** Valida o envelope do servidor. Qualquer sinal de procedimento executável ou escrita REAL invalida TUDO. */
export function parseServerLibrary(input: unknown): ServerLibrary {
  const data = rec(input);
  if (data['schemaVersion'] !== 1 || !text(data['libraryVersion']) || !Array.isArray(data['procedures'])) return bad();
  if (!data['procedures'].length) throw new InstructorLibraryError('empty');
  if (data['procedures'].length > 50) return bad();
  const procedures = data['procedures'].map((value): ServerProcedure => {
    const p = rec(value);
    if (p['execution'] !== 'not_executable' || p['realWrites'] !== false || p['requiresHumanReview'] !== true || p['validationStatus'] !== 'theory') return bad();
    if (!text(p['id']) || !/^[a-z][a-z0-9-]+$/.test(p['id'] as string) || !text(p['version']) || !text(p['purpose']) || !text(p['stop'])) return bad();
    if (!texts(p['instruments']) || !texts(p['symptoms']) || !texts(p['preconditions']) || !Array.isArray(p['steps']) || !p['steps'].length || p['steps'].length > 30) return bad();
    if (!Array.isArray(p['references']) || !p['references'].length) return bad();
    const steps = p['steps'].map((s): ServerStep => {
      const o = rec(s);
      if (!['id', 'control', 'instruction', 'verification', 'notFound'].every((k) => text(o[k])) || !texts(o['risks']) || !Array.isArray(o['references']) || !o['references'].length) return bad();
      return { id: o['id'] as string, control: o['control'] as string, instruction: o['instruction'] as string, verification: o['verification'] as string,
        notFound: o['notFound'] as string, risks: [...(o['risks'] as string[])], references: o['references'].map(citation) };
    });
    return { id: p['id'] as string, version: p['version'] as string, purpose: p['purpose'] as string, instruments: [...(p['instruments'] as string[])],
      symptoms: [...(p['symptoms'] as string[])], preconditions: [...(p['preconditions'] as string[])], steps, stop: p['stop'] as string, references: p['references'].map(citation) };
  });
  if (new Set(procedures.map((p) => p.id)).size !== procedures.length) return bad();
  return { schemaVersion: 1, libraryVersion: data['libraryVersion'] as string, procedures };
}

const INSTRUMENTS: Record<string, string> = { vozes: 'vozes', surdo: 'surdo', tanta: 'tantã', pandeiro: 'pandeiro', cavaco: 'cavaco', violao: 'violão' };
const SYMPTOMS: Record<string, string> = {
  embolado: 'som embolado', estridente: 'som estridente', abafado: 'voz ou fonte abafada', magro: 'falta de corpo ou grave', desequilibrio: 'desequilíbrio na mix',
  microfonia: 'microfonia', sibilancia: 'sibilância', clip: 'distorção ou clipping', ruido: 'ruído', monitoracao: 'problema na monitoração', ganho: 'ganho de entrada', processamento: 'EQ, HPF ou dinâmica',
};
const list = (items: string[], dict: Record<string, string>) => items.map((i) => dict[i] ?? i).join(', ');

/** Converte para o contrato de apresentação do Instrutor. O título vem do `purpose` publicado; nada é inventado. */
export function libraryToCatalog(library: ServerLibrary): InstructionCatalog {
  const procedures = library.procedures.map((p): Ui16Procedure => {
    const origin = p.references[0]!;
    const steps = p.steps.map((s): InstructionStep => ({
      id: s.id, control: s.control, action: s.instruction, expected: s.verification, alternative: s.notFound,
      caution: s.risks.join(' '), schematic: [s.control], // rótulo do manual, nunca posição nem captura de tela
    }));
    return {
      id: p.id, title: p.purpose, version: `${p.version} · biblioteca ${library.libraryVersion}`, validation: 'theory', scope: 'lab_instruction',
      purpose: `Leitura de estudo para ${list(p.instruments, INSTRUMENTS)} com relato de ${list(p.symptoms, SYMPTOMS)}.`,
      preconditions: [...p.preconditions],
      interfaceLimit: `Texto de estudo, não executável: teoria editorial MixAI, não validada em ensaio nem no firmware. Parar se: ${p.stop}`,
      origin: { title: origin.title, url: origin.url, locator: origin.section, version: origin.version }, steps,
    };
  });
  return { schemaVersion: 1, procedures };
}

/** Entrega o catálogo real ou lança InstructorLibraryError com o motivo (sessão, acesso, rede, versão, vazio). */
export async function loadInstructorLibrary(token: () => string | null, fetchFn: typeof fetch = fetch): Promise<InstructionCatalog> {
  const t = token();
  if (!t) throw new InstructorLibraryError('session');
  let res: Response;
  try {
    res = await fetchFn('/api/instructor/procedures', { headers: { authorization: `Bearer ${t}` }, cache: 'no-store', credentials: 'omit' });
  } catch { throw new InstructorLibraryError('unavailable'); }
  if (res.status === 401) throw new InstructorLibraryError('session');
  if (res.status === 403) throw new InstructorLibraryError('forbidden');
  if (!res.ok) throw new InstructorLibraryError('unavailable');
  let body: unknown;
  try { body = await res.json(); } catch { throw new InstructorLibraryError('incompatible'); }
  return libraryToCatalog(parseServerLibrary(body));
}

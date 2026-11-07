/**
 * Apresentação das fontes locais acrescentadas pelo servidor a uma resposta de diagnóstico.
 * Tudo aqui é texto de apoio: nunca ação, medição ou aprovação. A forma é validada (o servidor
 * pode ser de outra versão) e os tamanhos são limitados antes de chegar ao template.
 */
export interface KnowledgePassageView { title: string; url: string; locator: string; excerpt: string }
export interface KnowledgeView {
  mode: 'vector' | 'keyword' | 'deterministic';
  degraded: boolean;
  reason?: string;
  passages: KnowledgePassageView[];
  microphone?: { channel: string; musician: string; model: string | null; evidence: string; note: string };
  caseTitle?: string;
  narrative?: string;
}
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function knowledgeView(raw: unknown): KnowledgeView | undefined {
  const k = rec(raw);
  const mode = k['mode'];
  if (mode !== 'vector' && mode !== 'keyword' && mode !== 'deterministic') return undefined;
  const passages = (Array.isArray(k['passages']) ? k['passages'] : []).slice(0, 30).flatMap((p) => {
    const r = rec(p);
    const title = str(r['title'], 120), excerpt = str(r['excerpt'], 500);
    return title && excerpt ? [{ title, url: str(r['url'], 300) ?? '', locator: str(r['locator'], 60) ?? '', excerpt }] : [];
  }).slice(0, 6);
  const m = rec(k['microphone']);
  const note = str(m['note'], 400), channel = str(m['channel'], 8);
  const narrative = rec(k['narrative']);
  return {
    mode, degraded: k['degraded'] === true,
    reason: str(k['reason'], 160), passages,
    microphone: note && channel ? { channel, musician: str(m['musician'], 60) ?? '', model: str(m['model'], 80) ?? null, evidence: str(m['evidence'], 30) ?? 'unconfirmed', note } : undefined,
    caseTitle: str(rec(k['caseRef'])['title'], 120),
    // Texto do modelo local só aparece se o servidor o marcou como não verificado.
    narrative: narrative['verified'] === false ? str(narrative['text'], 700) : undefined,
  };
}

export const MODE_LABEL: Record<KnowledgeView['mode'], string> = {
  vector: 'busca semântica (Ollama)',
  keyword: 'busca por palavras',
  deterministic: 'só o motor determinístico',
};

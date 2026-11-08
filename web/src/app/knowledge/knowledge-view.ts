/**
 * Apresentação das fontes locais acrescentadas pelo servidor a uma resposta de diagnóstico.
 * Tudo aqui é texto de apoio: nunca ação, medição ou aprovação. A forma é validada (o servidor
 * pode ser de outra versão) e os tamanhos são limitados antes de chegar ao template.
 */
export interface KnowledgePassageView { title: string; url: string; locator: string; excerpt: string; caution?: string }
export interface KnowledgeView {
  mode: 'vector' | 'keyword' | 'deterministic';
  degraded: boolean;
  reason?: string;
  passages: KnowledgePassageView[];
  microphone?: { channel: string; musician: string; model: string | null; evidence: string; note: string };
  caseTitle?: string;
  narrative?: string;
  /** Por que não há resumo do modelo (só quando o servidor tentou e descartou). */
  narrativeNote?: string;
  /** Quem escreveu o resumo: o modelo local ou o Gemini (serviço externo). */
  narrativeSource?: 'ollama' | 'gemini';
  /** Resumo feito pelo modelo local porque o Gemini falhou. */
  fallbackNote?: string;
  /** Trechos de outros modelos de microfone deixados de fora. */
  modelNote?: string;
}

const NARRATIVE_NOTES: Record<string, string> = {
  timeout: 'Resumo do modelo local indisponível: demorou demais.',
  unavailable: 'Resumo do modelo local indisponível: o modelo de conversa não está pronto.',
  error: 'Resumo do modelo local indisponível: erro no serviço local.',
  empty: 'Resumo do modelo: sem base suficiente nos trechos para responder com segurança. Descreva o problema com mais detalhes ou consulte o operador.',
  echo: 'Resumo do modelo local descartado: apenas repetia os trechos.',
  blocked: 'Resumo do modelo local descartado por segurança (continha valores, comandos ou afirmação sobre o áudio).',
  auth: 'Resumo do Gemini indisponível: a chave foi recusada.',
  quota: 'Resumo do Gemini indisponível: limite de uso atingido.',
  refused: 'Resumo descartado: o provedor recusou o pedido por segurança. Nenhum outro modelo foi consultado.',
  recitation: 'Resumo descartado: o modelo não pôde responder sem reproduzir texto protegido.',
  withheld: 'Resumo não enviado ao serviço externo: os trechos vêm de documentos locais.',
  truncated: 'Resumo descartado: a resposta do modelo veio incompleta (parou no limite de tamanho).',
};
const FALLBACK_REASONS: Record<string, string> = {
  auth: 'recusou a chave', quota: 'atingiu o limite de uso', timeout: 'demorou demais', unavailable: 'não respondeu',
  error: 'deu erro', recitation: 'não pôde responder sem reproduzir texto protegido', withheld: 'não recebe trechos de documentos locais',
  truncated: 'devolveu a resposta incompleta',
};
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function knowledgeView(raw: unknown): KnowledgeView | undefined {
  const k = rec(raw);
  const mode = k['mode'];
  if (mode !== 'vector' && mode !== 'keyword' && mode !== 'deterministic') return undefined;
  const passages = (Array.isArray(k['passages']) ? k['passages'] : []).slice(0, 30).flatMap((p) => {
    const r = rec(p);
    const title = str(r['title'], 120), excerpt = str(r['excerpt'], 500);
    const caution = str(r['caution'], 200);
    return title && excerpt ? [{ title, url: str(r['url'], 300) ?? '', locator: str(r['locator'], 60) ?? '', excerpt, ...(caution ? { caution } : {}) }] : [];
  }).slice(0, 6);
  const m = rec(k['microphone']);
  const note = str(m['note'], 400), channel = str(m['channel'], 8);
  const narrative = rec(k['narrative']);
  const status = str(rec(k['narrativeStatus'])['status'], 20);
  const filter = rec(k['modelFilter']);
  const excluded = typeof filter['excluded'] === 'number' && filter['excluded'] > 0 ? Math.min(99, Math.floor(filter['excluded'])) : 0;
  const filterModel = str(filter['model'], 6);
  const ns = rec(k['narrativeStatus']);
  const source = narrative['source'] === 'gemini' ? 'gemini' : narrative['source'] === 'ollama' ? 'ollama' : undefined;
  const fellBack = str(ns['fellBackFrom'], 10) === 'gemini' ? FALLBACK_REASONS[str(ns['fallbackReason'], 20) ?? ''] : undefined;
  return {
    mode, degraded: k['degraded'] === true,
    reason: str(k['reason'], 160), passages,
    microphone: note && channel ? { channel, musician: str(m['musician'], 60) ?? '', model: str(m['model'], 80) ?? null, evidence: str(m['evidence'], 30) ?? 'unconfirmed', note } : undefined,
    caseTitle: str(rec(k['caseRef'])['title'], 120),
    // Texto do modelo local só aparece se o servidor o marcou como não verificado.
    narrative: narrative['verified'] === false ? str(narrative['text'], 700) : undefined,
    narrativeNote: narrative['verified'] === false || !status ? undefined : NARRATIVE_NOTES[status],
    narrativeSource: narrative['verified'] === false ? source : undefined,
    fallbackNote: narrative['verified'] === false && fellBack ? `Resumo gerado pelo modelo local porque o Gemini ${fellBack}.` : undefined,
    modelNote: excluded && filterModel ? `${excluded} trecho(s) que só descrevem outros modelos de microfone foram ocultados (este canal usa o ${filterModel}).` : undefined,
  };
}

export const MODE_LABEL: Record<KnowledgeView['mode'], string> = {
  vector: 'busca semântica (Ollama)',
  keyword: 'busca por palavras',
  deterministic: 'só o motor determinístico',
};

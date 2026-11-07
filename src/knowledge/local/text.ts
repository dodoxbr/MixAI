/** Normalização, tokenização e divisão de texto em trechos. Puro, sem E/S. */

export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'para', 'por', 'com', 'que', 'se', 'the', 'of', 'and', 'to', 'in', 'is', 'for']);

export function tokens(text: string): string[] {
  return normalize(text).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Remove controles e marcadores de direção; texto de documento é dado não confiável. */
export function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

export interface RawChunk { text: string; locator: string }

/**
 * Reconstrói parágrafos de texto extraído de PDF: o extrator entrega uma quebra de linha por linha
 * visual. Junta linhas, une palavras hifenizadas no fim da linha e descarta linhas que são só número
 * de página ou pontilhado de sumário. Dois tipos de quebra: linha em branco = parágrafo.
 */
export function reflow(block: string): string {
  const lines = block.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !/^\d{1,4}$/.test(l) && !/\.{6,}/.test(l));
  let out = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (/[A-Za-zÀ-ÿ]-$/.test(out) && /^[a-zà-ÿ]/.test(line)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return out;
}

/** Quebra um texto em frases (ou em janelas de palavras se uma frase passar do limite). */
function pieces(paragraph: string, max: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?;:])\s+(?=[A-ZÀ-Ý0-9•])/);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) { out.push(sentence); continue; }
    const words = sentence.split(' ');
    let cur = '';
    for (const w of words) {
      if (cur && cur.length + w.length + 1 > max) { out.push(cur); cur = w; } else cur += (cur ? ' ' : '') + w;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Divide em trechos de ~`target` caracteres cortando só em fim de frase (nunca no meio de uma
 * palavra) e repetindo a última frase como sobreposição (`overlap` = tamanho máximo dela).
 * Pontos de partida: linhas em branco; sem elas (PDF), as linhas são reunidas em parágrafos.
 */
export function chunkText(text: string, locator: string, target = 900, overlap = 160): RawChunk[] {
  const paragraphs = cleanText(text).split(/\n\s*\n/).map(reflow).filter(Boolean);
  const out: RawChunk[] = [];
  let buf: string[] = [];
  let size = 0;
  let fresh = false; // buf só tem a sobreposição: não vale um trecho próprio
  const flush = () => {
    const joined = buf.join(' ').trim();
    if (fresh || joined.length < 20) return;
    out.push({ text: joined, locator });
    const last = buf[buf.length - 1] ?? '';
    buf = last.length > 0 && last.length <= overlap ? [last] : [];
    size = buf.join(' ').length;
    fresh = buf.length > 0;
  };
  for (const paragraph of paragraphs) {
    for (const piece of pieces(paragraph, target)) {
      if (size + piece.length + 1 > target && buf.length) flush();
      buf.push(piece);
      size += piece.length + 1;
      fresh = false;
    }
  }
  flush();
  return out;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal Rank Fusion de duas listas (vetor e palavras). Mesmo trecho nas duas sobe no ranking. */
export function fuse<T extends { documentId: string; locator: string; excerpt: string; score: number; method: string }>(vector: T[], keyword: T[], limit: number, k = 60): Array<Omit<T, 'method'> & { method: 'hybrid' }> {
  const key = (p: T) => `${p.documentId}\u0000${p.locator}\u0000${p.excerpt}`;
  const merged = new Map<string, { item: T; score: number }>();
  for (const list of [vector, keyword]) {
    list.forEach((p, i) => {
      const prev = merged.get(key(p));
      const add = 1 / (k + i + 1);
      if (prev) prev.score += add; else merged.set(key(p), { item: p, score: add });
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ item, score }) => ({ ...item, score: Number((score * (k + 1)).toFixed(4)), method: 'hybrid' as const }));
}

export function excerpt(text: string, max = 420): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

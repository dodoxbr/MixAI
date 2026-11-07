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

/** Divide por parágrafos em trechos de ~`target` caracteres, com sobreposição curta. */
export function chunkText(text: string, locator: string, target = 900, overlap = 120): RawChunk[] {
  const paragraphs = cleanText(text).split(/\n\s*\n|\r\n\s*\r\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: RawChunk[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim().length >= 20) out.push({ text: buf.trim(), locator });
    buf = buf.length > overlap ? buf.slice(-overlap) : '';
  };
  for (const p of paragraphs) {
    if (p.length > target * 2) {
      // Parágrafo gigante (PDF sem quebras): corta em janelas.
      for (let i = 0; i < p.length; i += target - overlap) {
        buf = p.slice(i, i + target);
        flush();
      }
      buf = '';
      continue;
    }
    if (buf.length + p.length + 1 > target) flush();
    buf += (buf ? ' ' : '') + p;
  }
  if (buf.trim().length >= 20 && !out.some((c) => c.text.endsWith(buf.trim()))) out.push({ text: buf.trim(), locator });
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

export function excerpt(text: string, max = 420): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

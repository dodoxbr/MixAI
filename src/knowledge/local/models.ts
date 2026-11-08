/**
 * Modelos de microfone AKG Perception citados em um texto. Os folhetos do fabricante põem vários
 * modelos lado a lado na mesma tabela (ex.: "P3  P5/P5 S"); sem esta marcação, uma busca pelo P3 S
 * poderia devolver o supercardioide do P5 como se fosse do P3. Puro, sem E/S.
 */
export type PerceptionModel = 'P2' | 'P3' | 'P4' | 'P5';

/** "P3", "P 3", "P5 S", "P5/P5S"... Não casa "P30" nem palavras como "PA". */
const MODEL_RE = /(?<![A-Za-z0-9])P\s?([2-5])(?:\s?S)?(?![A-Za-z0-9])/g;

export function mentionedModels(text: string): Set<PerceptionModel> {
  const found = new Set<PerceptionModel>();
  for (const m of text.matchAll(MODEL_RE)) found.add(`P${m[1]}` as PerceptionModel);
  return found;
}

/** "AKG Perception P3 S" → "P3". Modelos fora da família (ou texto livre) → undefined. */
export function modelKeyOf(modelName: string | null | undefined): PerceptionModel | undefined {
  if (!modelName) return undefined;
  const m = mentionedModels(modelName);
  return m.size === 1 ? [...m][0] : undefined;
}

export type ModelScope = 'none' | 'match' | 'mixed' | 'other';

/**
 * Como um trecho se relaciona com o microfone do canal:
 * none = não cita modelo (teoria geral); match = só o modelo do canal; mixed = o do canal e outros
 * (tabela comparativa); other = só outros modelos (não descreve este microfone).
 */
export function scopeOf(models: readonly string[], own: PerceptionModel | undefined): ModelScope {
  if (!models.length) return 'none';
  if (!own) return models.length > 1 ? 'mixed' : 'none';
  if (!models.includes(own)) return 'other';
  return models.length > 1 ? 'mixed' : 'match';
}

export const scopeFor = (text: string, own: PerceptionModel | undefined): ModelScope => scopeOf([...mentionedModels(text)], own);

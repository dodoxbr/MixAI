/** Verifica logs JSONL sem confundir partes de timestamps/métricas com um PIN.
 * Strings/chaves são examinadas integralmente (inclusive JSON escapado em strings).
 * Números iguais ao segredo ainda contam como vazamento de PIN numérico. Só o `ts`
 * numérico na raiz do registro Caddy é metadado; texto/malformed JSON mantém busca bruta.
 * Retorna booleano para a asserção não despejar diagnósticos/credenciais na própria CI.
 */
export function diagnosticsContainSecret(logs: string, secrets: readonly string[]): boolean {
  const values = secrets.filter(s => s.length > 0);
  const contains = (text: string) => values.some(s => text.includes(s));
  const scan = (value: unknown, root = false): boolean => {
    if (typeof value === 'string') return contains(value);
    if (typeof value === 'number') return values.includes(String(value));
    if (Array.isArray(value)) return value.some(v => scan(v));
    if (value && typeof value === 'object') return Object.entries(value).some(([key, v]) =>
      contains(key) || (!(root && key === 'ts' && typeof v === 'number') && scan(v)));
    return false;
  };
  return logs.split(/\r?\n/).some(line => {
    try { return scan(JSON.parse(line), true); }
    catch { return contains(line); }
  });
}

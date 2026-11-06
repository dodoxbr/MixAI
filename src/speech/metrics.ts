export function words(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]+/gu) ?? [];
}
/** WER preserves accents/numbers; punctuation/case/spacing do not count. Empty reference is a silence/noise check. */
export function transcriptScore(reference: string, hypothesis: string) {
  const expected = words(reference);
  const actual = words(hypothesis);
  if (expected.length > 512 || actual.length > 512) throw new Error('METRIC_LIMIT');
  let row = actual.map((_, i) => i + 1); row.unshift(0);
  for (let i = 1; i <= expected.length; i++) {
    const next = [i];
    for (let j = 1; j <= actual.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1));
    row = next;
  }
  const errors = row[actual.length]!;
  return { wordErrors: errors, referenceWords: expected.length, hypothesisWords: actual.length, wer: expected.length ? errors / expected.length : null, exactNormalized: errors === 0, falsePositiveOnSilence: expected.length === 0 ? actual.length > 0 : null };
}
/** Nearest-rank quantiles. Never mix simulated and real measurements in one summary. */
export function summarizeMeasurements(samples: Array<{ processingMs: number; failed: boolean }>) {
  if (samples.some(s => !Number.isFinite(s.processingMs) || s.processingMs < 0)) throw new Error('METRIC_LIMIT');
  const successful = samples.filter(s => !s.failed).map(s => s.processingMs).sort((a, b) => a - b);
  const percentile = (p: number) => successful.length ? successful[Math.ceil(p * successful.length) - 1]! : null;
  return { samples: samples.length, failures: samples.filter(s => s.failed).length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), cpuMs: null, peakRssBytes: null };
}

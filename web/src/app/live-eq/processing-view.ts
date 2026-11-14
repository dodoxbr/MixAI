import {
  magnitudeDB,
  peakCoefficients,
  plotFrequency,
  type EqBandResponse,
} from '../../../../src/core/eq-response';
export type Quality = 'confirmed' | 'last_observation' | 'stale' | 'unknown';
export interface Reading {
  state: Quality;
  value?: number | boolean;
  ageMs: number | null;
  freshnessMs: number;
  current: boolean;
  raw?: number;
}
export interface ProcessingView {
  generation: number;
  parameters: Record<string, Reading>;
}
const record = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : {};
export const unknownReading = (): Reading => ({
  state: 'unknown',
  ageMs: null,
  freshnessMs: 3000,
  current: false,
});
/** Deliberately consumes independent display evidence only, never the library cache or write availability. */
export function parseProcessing(body: unknown, channel: number, serverId: string): ProcessingView {
  const b = record(body),
    connection = record(b['connection']);
  if (
    b['schemaVersion'] !== 1 ||
    b['channel'] !== channel ||
    b['serverId'] !== serverId ||
    !Number.isInteger(connection['generation'])
  )
    throw Error('Resposta de processamento incompatível.');
  const parameters: Record<string, Reading> = {};
  for (const [key, entry] of Object.entries(record(b['parameters']))) {
    const match = new RegExp(
      `^ch\\.${channel}\\.eq\\.(b[1-4]\\.(freq|gain|q)|hpf\\.freq|bypass)$`,
    ).exec(key);
    if (!match) continue;
    const d = record(record(entry)['display']),
      value = d['value'],
      field = match[2] ?? match[1];
    const valid =
      field === 'bypass'
        ? typeof value === 'boolean'
        : typeof value === 'number' &&
          Number.isFinite(value) &&
          (field === 'gain'
            ? value >= -20 && value <= 20
            : field === 'q'
              ? value >= 0.05 && value <= 15
              : value >= 20 && value <= (field === 'hpf.freq' ? 1000 : 22050));
    if (
      d['source'] !== 'independent_socket_input' ||
      !valid ||
      !['confirmed', 'last_observation', 'stale'].includes(String(d['state'])) ||
      typeof d['ageMs'] !== 'number' ||
      !Number.isFinite(d['ageMs']) ||
      d['ageMs'] < 0 ||
      typeof d['freshnessMs'] !== 'number' ||
      !Number.isFinite(d['freshnessMs']) ||
      d['freshnessMs'] < 10 ||
      d['freshnessMs'] > 30000
    ) {
      parameters[key] = unknownReading();
      continue;
    }
    const current = d['connectionCurrent'] === true && d['generation'] === connection['generation'];
    parameters[key] = {
      state: current ? (d['state'] as Quality) : 'stale',
      value: value as number | boolean,
      ageMs: d['ageMs'],
      freshnessMs: d['freshnessMs'],
      current,
      ...(typeof d['rawValue'] === 'number' ? { raw: d['rawValue'] } : {}),
    };
  }
  return { generation: connection['generation'] as number, parameters };
}
export function aged(r: Reading, elapsed: number): Reading {
  const ageMs = r.ageMs === null ? null : r.ageMs + Math.max(0, elapsed);
  return {
    ...r,
    ageMs,
    state:
      r.state === 'confirmed' && ageMs !== null && ageMs > r.freshnessMs
        ? 'last_observation'
        : r.state,
  };
}
export const qualityLabel = (s: Quality) =>
  ({
    confirmed: 'Confirmado',
    last_observation: 'Última observação',
    stale: 'Desatualizado',
    unknown: 'Desconhecido',
  })[s];
export function bandCurve(
  read: (suffix: string) => Reading,
): { path: string; old: boolean } | null {
  const usable = (r: Reading) =>
    r.current && (r.state === 'confirmed' || r.state === 'last_observation');
  const bypass = read('bypass');
  if (!usable(bypass) || typeof bypass.value !== 'boolean') return null;
  const bands: EqBandResponse[] = [];
  let old = bypass.state === 'last_observation';
  for (let i = 1; i <= 4; i++) {
    const f = read(`b${i}.freq`),
      g = read(`b${i}.gain`),
      q = read(`b${i}.q`);
    if (![f, g, q].every((r) => usable(r) && typeof r.value === 'number')) return null;
    old ||= [f, g, q].some((r) => r.state === 'last_observation');
    bands.push({ freq: f.value as number, gain: g.value as number, q: q.value as number });
  }
  const filters = bypass.value ? [] : bands.map(peakCoefficients);
  return {
    old,
    path: Array.from(
      { length: 181 },
      (_, i) =>
        `${i ? 'L' : 'M'}${40 + (i / 180) * 660},${140 - Math.max(-24, Math.min(24, magnitudeDB(filters, plotFrequency(i / 180)))) * 5}`,
    ).join(' '),
  };
}

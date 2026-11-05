/**
 * Escala do fader (posição 0..1 ↔ dB), no estilo das mesas: mais resolução perto de 0 dB.
 * Posição 0 = -∞ (fader todo para baixo). Topo = +10 dB (o servidor limita ao teto configurado).
 */
const POINTS: ReadonlyArray<readonly [pos: number, db: number]> = [
  [0.04, -60],
  [0.15, -40],
  [0.27, -30],
  [0.42, -20],
  [0.58, -10],
  [0.68, -5],
  [0.78, 0],
  [0.89, 5],
  [1, 10],
];

export const FADER_MIN_DB = -60;
export const FADER_MAX_DB = 10;
/** Abaixo disso o servidor trata como fader todo para baixo. */
export const SILENCE_DB = -80;

export function dbToPos(db: number): number {
  if (!Number.isFinite(db)) return db > 0 ? 1 : 0;
  if (db <= SILENCE_DB) return 0;
  if (db >= FADER_MAX_DB) return 1;
  if (db < FADER_MIN_DB) return (POINTS[0]![0] * (db - SILENCE_DB)) / (FADER_MIN_DB - SILENCE_DB);
  for (let i = 1; i < POINTS.length; i++) {
    const [p1, d1] = POINTS[i]!;
    const [p0, d0] = POINTS[i - 1]!;
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}

/** Posição → dB, arredondado a 0,5 dB. Abaixo de 1% = -∞. */
export function posToDb(pos: number): number {
  const p = Math.max(0, Math.min(1, pos));
  if (p < 0.01) return -Infinity;
  if (p < POINTS[0]![0]) return round(SILENCE_DB + (p / POINTS[0]![0]) * (FADER_MIN_DB - SILENCE_DB));
  for (let i = 1; i < POINTS.length; i++) {
    const [p1, d1] = POINTS[i]!;
    const [p0, d0] = POINTS[i - 1]!;
    if (p <= p1) return round(d0 + ((p - p0) / (p1 - p0)) * (d1 - d0));
  }
  return FADER_MAX_DB;
}

const round = (db: number) => Math.round(db * 2) / 2;

/** Texto do valor com o sinal de menos tipográfico: "−∞", "−10.0", "+3.5", "0.0". */
export function formatDb(db: number | null | undefined): string {
  if (db === null || db === undefined) return '—';
  if (!Number.isFinite(db)) return db < 0 ? '−∞' : '+∞';
  const r = Math.round(db * 10) / 10;
  if (r === 0) return '0.0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}`;
}

/** Passo do teclado a partir de um valor (de -∞, subir vai para -60). */
export function stepDb(db: number, delta: number): number {
  if (!Number.isFinite(db)) return delta > 0 ? FADER_MIN_DB : -Infinity;
  const next = round(db + delta);
  if (next < FADER_MIN_DB) return delta < 0 && db <= FADER_MIN_DB ? -Infinity : FADER_MIN_DB;
  return Math.min(FADER_MAX_DB, next);
}

/** Marcas da régua do fader. */
export const SCALE_MARKS: ReadonlyArray<{ db: number; label: string }> = [
  { db: 10, label: '+10' },
  { db: 5, label: '+5' },
  { db: 0, label: '0' },
  { db: -10, label: '−10' },
  { db: -20, label: '−20' },
  { db: -30, label: '−30' },
  { db: -40, label: '−40' },
  { db: -60, label: '−60' },
  { db: -Infinity, label: '−∞' },
];

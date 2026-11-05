import { dbToPos, formatDb, posToDb, stepDb } from './db';

describe('escala do fader (dB ↔ posição)', () => {
  it('-∞ fica no fundo e o topo é +10 dB', () => {
    expect(dbToPos(-Infinity)).toBe(0);
    expect(dbToPos(-100)).toBe(0);
    expect(posToDb(0)).toBe(-Infinity);
    expect(dbToPos(10)).toBe(1);
    expect(posToDb(1)).toBe(10);
  });

  it('ida e volta preserva o valor (resolução de 0,5 dB)', () => {
    for (const db of [-60, -45, -30, -20, -12.5, -10, -6, -3, -0.5, 0, 2.5, 5, 9.5]) {
      expect(posToDb(dbToPos(db))).toBe(db);
    }
  });

  it('é monotônica (subir o fader nunca abaixa o volume)', () => {
    let last = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.005) {
      const db = posToDb(p);
      expect(db).toBeGreaterThanOrEqual(last);
      last = db;
    }
  });

  it('mais resolução perto de 0 dB do que no fundo', () => {
    expect(dbToPos(0) - dbToPos(-10)).toBeGreaterThan(dbToPos(-40) - dbToPos(-50));
  });

  it('formata com sinal tipográfico e -∞', () => {
    expect(formatDb(-Infinity)).toBe('−∞');
    expect(formatDb(-10)).toBe('−10.0');
    expect(formatDb(3.5)).toBe('+3.5');
    expect(formatDb(0)).toBe('0.0');
    expect(formatDb(null)).toBe('—');
  });

  it('passos do teclado: de -∞ sobe para -60; abaixo de -60 vai para -∞', () => {
    expect(stepDb(-Infinity, 1)).toBe(-60);
    expect(stepDb(-60, -1)).toBe(-Infinity);
    expect(stepDb(-59.5, -1)).toBe(-60);
    expect(stepDb(9.5, 5)).toBe(10);
    expect(stepDb(-10, 1)).toBe(-9);
  });
});

import {
  EQ_FILTERS,
  EQ_FREQUENCY_MAX,
  EQ_FREQUENCY_MIN,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  EQ_Q_MAX,
  EQ_Q_MIN,
} from 'soundcraft-ui-connection';
import { describe, expect, it } from 'vitest';
import { LIMITS, ParamRegistry } from '../src/core/params.js';
import { asParamKey, paramKey, parseKey } from '../src/core/revisions.js';
import { MASTER } from '../src/mixer/types.js';

const reg = new ParamRegistry({ model: 'ui16', inputs: 12, aux: 6 });

describe('registro central de parâmetros', () => {
  it('cobre master, 12 canais × (main + 6 AUX) e EQ/HPF/bypass por canal', () => {
    // 1 master + 12 × (2 main + 6×2 aux + 4×3 bandas + 2 HPF + 1 bypass)
    expect(reg.keys()).toHaveLength(1 + 12 * (2 + 12 + 12 + 2 + 1));
    expect(reg.has(paramKey.eqBand(12, 4, 'gain'))).toBe(true);
    expect(reg.has(paramKey.hpf(1, 'slope'))).toBe(true);
    expect(reg.has(paramKey.eqBypass(3))).toBe(true);
    expect(reg.has(paramKey.level(13, MASTER))).toBe(false);
  });

  it('limites de EQ/HPF batem com as constantes da biblioteca instalada', () => {
    expect(LIMITS.eqFreq).toEqual({ min: EQ_FREQUENCY_MIN, max: EQ_FREQUENCY_MAX });
    expect(LIMITS.eqQ).toEqual({ min: EQ_Q_MIN, max: EQ_Q_MAX });
    expect(LIMITS.eqGain).toEqual({ min: EQ_GAIN_MIN_DB, max: EQ_GAIN_MAX_DB });
    expect(LIMITS.hpfFreq).toEqual({ min: EQ_FILTERS.hpf.minHz, max: EQ_FILTERS.hpf.maxHz });
  });

  it('capacidades: nível/mute verificados na biblioteca; EQ só no laboratório', () => {
    expect(reg.get(paramKey.level(1, MASTER))).toMatchObject({ capability: 'library_verified', applicableToMixer: true, unit: 'dB' });
    expect(reg.get(paramKey.eqBand(1, 1, 'freq'))).toMatchObject({ capability: 'simulated_only', applicableToMixer: false, unit: 'Hz' });
    expect(reg.mixerKeys().some((k) => k.includes('.eq.'))).toBe(false);
    expect(reg.specs().some((s) => s.capability === 'hardware_verified')).toBe(false); // nada testado na mesa ainda
  });

  it('validação: faixas, -∞ só para nível, valores discretos e tipos', () => {
    expect(reg.validate(paramKey.level(1, MASTER), -Infinity)).toBeUndefined();
    expect(reg.validate(paramKey.level(1, MASTER), 10)).toBeUndefined();
    expect(reg.validate(paramKey.level(1, MASTER), 10.5)).toMatch(/máximo/);
    expect(reg.validate(paramKey.eqBand(1, 2, 'gain'), -Infinity)).toMatch(/não finito/);
    expect(reg.validate(paramKey.eqBand(1, 2, 'q'), 0.01)).toMatch(/mínimo/);
    expect(reg.validate(paramKey.hpf(1, 'freq'), 1200)).toMatch(/máximo/);
    expect(reg.validate(paramKey.hpf(1, 'slope'), 18)).toMatch(/12\/24\/36/);
    expect(reg.validate(paramKey.hpf(1, 'slope'), 24)).toBeUndefined();
    expect(reg.validate(paramKey.mute(1, MASTER), 1)).toMatch(/verdadeiro\/falso/);
    expect(reg.validate(paramKey.eqBypass(1), true)).toBeUndefined();
    expect(reg.validate('ch.99.main.level' as never, 0)).toMatch(/desconhecido/);
  });

  it('valores iniciais do laboratório são válidos e neutros (EQ com ganho 0, HPF desligado)', () => {
    for (const s of reg.specs()) expect(reg.validate(s.key, s.labDefault)).toBeUndefined();
    expect(reg.get(paramKey.eqBand(1, 1, 'gain'))!.labDefault).toBe(0);
    expect(reg.get(paramKey.hpf(1, 'freq'))!.labDefault).toBe(20);
  });

  it('chaves: parse e reconhecimento de texto', () => {
    expect(parseKey(paramKey.eqBand(3, 2, 'q'))).toEqual({ kind: 'eq', channel: 3, band: 2, param: 'q' });
    expect(parseKey(paramKey.hpf(3, 'slope'))).toEqual({ kind: 'hpf', channel: 3, param: 'slope' });
    expect(parseKey(paramKey.eqBypass(3))).toEqual({ kind: 'eqBypass', channel: 3 });
    expect(parseKey('ch.2.aux.1.mute')).toEqual({ kind: 'channel', channel: 2, aux: 1, param: 'mute' });
    expect(asParamKey('ch.1.eq.b5.gain')).toBeUndefined();
    expect(asParamKey('master.level')).toBe('master.level');
    expect(asParamKey('qualquer coisa')).toBeUndefined();
  });
});

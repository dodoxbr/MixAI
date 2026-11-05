import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig, PROJECT_ROOT } from '../src/core/config.js';

const read = (file: string) => parse(readFileSync(join(PROJECT_ROOT, 'config', file), 'utf8'));

describe('configuração entregue (config/)', () => {
  it('config.yaml é válido', () => {
    const cfg = parseConfig(read('config.yaml'));
    expect(cfg.mixer.model).toBe('ui16');
    expect(cfg.safety.maxStepDB).toBeGreaterThan(0);
  });

  it('channels.yaml é válido, sem número repetido e dentro dos limites da Ui16', () => {
    const ch = parseChannels(read('channels.yaml'));
    const nums = ch.channels.map((c) => c.number);
    expect(new Set(nums).size).toBe(nums.length);
    expect(Math.max(...nums)).toBeLessThanOrEqual(12);
    const aux = ch.aux.map((a) => a.number);
    expect(new Set(aux).size).toBe(aux.length);
    expect(Math.max(...aux)).toBeLessThanOrEqual(6);
  });

  it('nomes da banda atual resolvem para o canal certo', () => {
    const map = new ChannelMap(parseChannels(read('channels.yaml')), { inputs: 12, aux: 6 });
    expect(map.channel('voz do fred').name).toBe('Voz Fred');
    expect(map.channel('lucius').name).toBe('Voz Lucius');
    expect(map.channel('Leandro').name).toBe('Voz Leandro');
    expect(map.channel('fernando').name).toBe('Voz Fernando');
    expect(map.channel('tantan').name).toBe('Tantã');
    expect(map.channel('surdão').name).toBe('Surdo');
    expect(map.channel('cavaquinho').name).toBe('Cavaco');
    expect(map.channel('lavi').name).toBe('Laviquinho');
    expect(map.channel('convidado').number).toBe(11);
    expect(map.auxBus('fone').name).toBe('Fones');
    expect(map.auxBus('retorno').name).toBe('Fones');
    expect(map.auxBus('aux 1').name).toBe('Fones');
  });
});

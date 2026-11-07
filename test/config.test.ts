import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseRequest } from '../src/assistant/nl-parser.js';
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
    expect(map.channel('lavi').name).toBe('Voz Laviquinho');
    expect(map.channel('convidado').number).toBe(11);
    expect(map.auxBus('fone').name).toBe('Fones');
    expect(map.auxBus('retorno').name).toBe('Fones');
    expect(map.auxBus('aux 1').name).toBe('Fones');
  });

  it('mapa físico atual identifica voz lead, quatro coros e percussão nos canais corretos', () => {
    const map = new ChannelMap(parseChannels(read('channels.yaml')), { inputs: 12, aux: 6 }, { allowUnmapped: false });
    const expected = [
      ['cavaco', 1], ['violão', 2], ['fred', 3], ['lucius', 4],
      ['leandro', 5], ['fernando', 6], ['laviquinho', 7],
      ['surdo', 8], ['pandeiro', 9], ['tantan', 10], ['reserva', 11],
    ] as const;
    for (const [alias, number] of expected) {
      expect(map.channel(alias).number).toBe(number);
    }
    // CH12 fica livre, sem apelido cadastrado.
    expect(parseChannels(read('channels.yaml')).channels.some((ch) => ch.number === 12)).toBe(false);
  });

  it('parser real usa o novo mapa físico para Surdo, Pandeiro e Laviquinho', () => {
    const map = new ChannelMap(parseChannels(read('channels.yaml')), { inputs: 12, aux: 6 }, { allowUnmapped: false });
    const steps = { smallStepDB: 2, mediumStepDB: 3, largeStepDB: 5 };
    const ask = (text: string) => parseRequest(text, { names: map, role: 'operator', steps });
    expect(ask('sobe o surdo no PA')).toEqual({
      kind: 'intents', intents: [{ type: 'level', channel: 8, dest: 'pa', deltaDB: 2 }],
    });
    expect(ask('muta o pandeiro no PA')).toEqual({
      kind: 'intents', intents: [{ type: 'mute', channels: [9], dest: 'pa', muted: true }],
    });
    expect(ask('sobe a voz do Laviquinho nos fones')).toEqual({
      kind: 'intents', intents: [{ type: 'level', channel: 7, dest: 'fones', deltaDB: 2 }],
    });
  });

});

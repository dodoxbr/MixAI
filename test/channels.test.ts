import { describe, expect, it } from 'vitest';
import { ChannelMap, NameResolutionError, normalize } from '../src/core/channels.js';
import { fixtureChannels } from './helpers.js';

const map = new ChannelMap(fixtureChannels(), { inputs: 12, aux: 6 });

describe('nomes de canais', () => {
  it('ignora acento, maiúscula e espaço', () => {
    expect(normalize('Violão 2')).toBe('violao2');
    expect(map.channel('VIOLÃO').number).toBe(5);
    expect(map.channel('violao').number).toBe(5);
    expect(map.channel('Voz2').number).toBe(2);
  });

  it('entende apelidos', () => {
    expect(map.channel('cavaquinho')).toEqual({ number: 4, name: 'Cavaco' });
    expect(map.channel('surdão').number).toBe(6);
    expect(map.channel('vocal principal').number).toBe(1);
    expect(map.channel('7 cordas').number).toBe(5);
  });

  it('aceita número e "canal N", mesmo sem apelido', () => {
    expect(map.channel(3).number).toBe(3);
    expect(map.channel('canal 9')).toEqual({ number: 9, name: 'Canal 9' });
    expect(map.channel('ch 12').number).toBe(12);
    expect(map.channel('o cavaco').number).toBe(4);
  });

  it('recusa canal que não existe', () => {
    expect(() => map.channel('canal 13')).toThrow(NameResolutionError);
    expect(() => map.channel('trombone')).toThrow(/Nomes conhecidos/);
    expect(() => map.channel('')).toThrow(NameResolutionError);
  });
});

describe('nomes de retornos', () => {
  it('entende "retorno do cavaco" e variações', () => {
    expect(map.auxBus('retorno do cavaco').number).toBe(2);
    expect(map.auxBus('monitor do cavaquinho').number).toBe(2);
    expect(map.auxBus('cavaco').number).toBe(2);
    expect(map.auxBus('Retorno Violão').number).toBe(3);
    expect(map.auxBus('retorno do cantor').number).toBe(1);
  });

  it('aceita "aux N" até o limite da Ui16', () => {
    expect(map.auxBus('aux 4').number).toBe(4);
    expect(map.auxBus('aux 6').name).toBe('AUX 6');
    expect(() => map.auxBus('aux 7')).toThrow(/não existe/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseRequest } from '../src/assistant/nl-parser.js';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, PROJECT_ROOT } from '../src/core/config.js';

// Nomes REAIS da banda (config/channels.yaml), como no dia a dia.
const names = new ChannelMap(parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8'))), { inputs: 12, aux: 6 }, { allowUnmapped: false });
const steps = { smallStepDB: 2, mediumStepDB: 3, largeStepDB: 5 };
const op = (t: string) => parseRequest(t, { names, role: 'operator', steps });
const mus = (t: string) => parseRequest(t, { names, role: 'musician', steps });

describe('parser local: comandos sem internet (os exemplos do pedido)', () => {
  it('"Diminui 3 dB da voz Fernando no PA."', () => {
    expect(op('Diminui 3 dB da voz Fernando no PA.')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 6, dest: 'pa', deltaDB: -3 }] });
  });
  it('"Sobe o cavaco nos fones."', () => {
    expect(op('Sobe o cavaco nos fones.')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 1, dest: 'fones', deltaDB: 2 }] });
  });
  it('"Desfaz o último ajuste."', () => {
    expect(op('Desfaz o último ajuste.')).toEqual({ kind: 'intents', intents: [{ type: 'undo' }] });
  });
  it('"Aumenta um pouco o surdo." sem destino: pergunta PA ou FONES (não presume)', () => {
    const r = op('Aumenta um pouco o surdo.');
    expect(r.kind).toBe('clarify');
    if (r.kind !== 'clarify') return;
    expect(r.options.map((o) => o.label)).toEqual(['PA', 'Fones']);
    expect(op(r.options[0]!.text)).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'pa', deltaDB: 2 }] });
    expect(op(r.options[1]!.text)).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'fones', deltaDB: 2 }] });
  });
  it('"Muta o pandeiro." sem destino: pergunta; com destino: mute', () => {
    expect(op('Muta o pandeiro.').kind).toBe('clarify');
    expect(op('Muta o pandeiro no PA')).toEqual({ kind: 'intents', intents: [{ type: 'mute', channels: [7], dest: 'pa', muted: true }] });
  });
});

describe('expressões relativas (configuráveis)', () => {
  it('"um pouco" = pequeno, "mais" = médio, "bastante" = grande, sem qualificador = pequeno', () => {
    const d = (t: string) => (op(t) as { intents: Array<{ deltaDB?: number }> }).intents[0]!.deltaDB;
    expect(d('aumenta um pouco o surdo no PA')).toBe(2);
    expect(d('aumenta mais o surdo no PA')).toBe(3);
    expect(d('aumenta bastante o surdo no PA')).toBe(5);
    expect(d('abaixa muito o surdo no PA')).toBe(-5);
    expect(d('sobe o surdo no PA')).toBe(2);
    expect(d('diminui 4 db do surdo no PA')).toBe(-4);
    const custom = parseRequest('aumenta bastante o surdo no PA', { names, role: 'operator', steps: { smallStepDB: 1, mediumStepDB: 2, largeStepDB: 4 } });
    expect((custom as { intents: Array<{ deltaDB?: number }> }).intents[0]!.deltaDB).toBe(4);
  });
  it('"para/em N" é valor absoluto (inclusive com verbo de subir)', () => {
    expect(op('coloca o surdo em -12 no PA')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'pa', db: -12 }] });
    expect(op('aumenta o surdo para -5 db nos fones')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'fones', db: -5 }] });
  });
});

describe('canais e destinos', () => {
  it('apelidos, acentos e maiúsculas; "mais surdo no fone" mexe SÓ no surdo nos fones', () => {
    expect(op('mais surdo no fone')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'fones', deltaDB: 2 }] });
    expect(op('SOBE O SURDÃO NO RETORNO')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'fones', deltaDB: 2 }] });
    expect(op('aumenta mais o lavi no retorno')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 10, dest: 'fones', deltaDB: 3 }] });
    expect(op('abaixa a voz do Fred no PA')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 3, dest: 'pa', deltaDB: -2 }] });
  });
  it('número dentro do nome não vira quantidade ("7 cordas" é o violão)', () => {
    expect(op('sobe o 7 cordas no pa')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 2, dest: 'pa', deltaDB: 2 }] });
  });
  it('vários canais: abre cavaco e violão nos fones', () => {
    expect(op('abre o cavaco e o violão nos fones')).toEqual({ kind: 'intents', intents: [{ type: 'mute', channels: [1, 2], dest: 'fones', muted: false }] });
  });
  it('master: proposta separada (nunca mute)', () => {
    expect(op('baixa o master 2 db')).toEqual({ kind: 'intents', intents: [{ type: 'master', deltaDB: -2 }] });
    expect(op('muta o master').kind).toBe('answer');
  });
  it('músico: o único destino possível é FONES (o cartão mostra isso)', () => {
    expect(mus('sobe o surdo')).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 9, dest: 'fones', deltaDB: 2 }] });
  });
});

describe('ambiguidade pede esclarecimento; nunca inventa canal', () => {
  it('"voz" serve para várias: pergunta qual', () => {
    const r = op('aumenta bastante a voz no PA');
    expect(r.kind).toBe('clarify');
    if (r.kind !== 'clarify') return;
    expect(r.options.map((o) => o.label)).toEqual(['Voz Fred', 'Voz Lucius', 'Voz Leandro', 'Voz Fernando']);
    expect(op(r.options[3]!.text)).toEqual({ kind: 'intents', intents: [{ type: 'level', channel: 6, dest: 'pa', deltaDB: 5 }] });
  });
  it('canal que não existe ("guitarra"): pergunta entre os cadastrados', () => {
    const r = op('sobe a guitarra no PA');
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.question).toContain('Não reconheci');
  });
  it('PA e fones ao mesmo tempo: pede um de cada vez', () => {
    expect(op('sobe o surdo no pa e nos fones').kind).toBe('clarify');
  });
  it('pedido que o parser não entende fica para a IA (unknown)', () => {
    expect(op('tá meio embolado o som').kind).toBe('unknown');
    expect(op('como está a mix?').kind).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { HELP, parseCommand } from '../src/core/parser.js';
import { fixtureChannels } from './helpers.js';

const names = new ChannelMap(fixtureChannels(), { inputs: 12, aux: 6 });
const p = (line: string) => parseCommand(line, names);

describe('parser determinístico (extraído do console, mesmo comportamento)', () => {
  it('gera os mesmos comandos de antes para as frases do HELP', () => {
    expect(p('status')).toEqual({ kind: 'status' });
    expect(p('estado')).toEqual({ kind: 'state', aux: undefined });
    expect(p('estado @ cavaco')).toEqual({ kind: 'state', aux: 'cavaco' });
    expect(p('sobe voz 1')).toEqual({ kind: 'level', channel: 'voz 1', aux: undefined, deltaDB: 2 });
    expect(p('sobe voz 1 3')).toEqual({ kind: 'level', channel: 'voz 1', aux: undefined, deltaDB: 3 });
    expect(p('desce cavaco')).toEqual({ kind: 'level', channel: 'cavaco', aux: undefined, deltaDB: -2 });
    expect(p('desce cavaco 4')).toEqual({ kind: 'level', channel: 'cavaco', aux: undefined, deltaDB: -4 });
    expect(p('sobe voz 1 3 @ cavaco')).toEqual({ kind: 'level', channel: 'voz 1', aux: 'cavaco', deltaDB: 3 });
    expect(p('nivel cavaco -12')).toEqual({ kind: 'level', channel: 'cavaco', aux: undefined, db: -12 });
    expect(p('nivel cavaco -12,5')).toEqual({ kind: 'level', channel: 'cavaco', aux: undefined, db: -12.5 });
    expect(p('muta surdo, violão')).toEqual({ kind: 'mute', channels: ['surdo', 'violão'], muted: true, aux: undefined });
    expect(p('abre surdo')).toEqual({ kind: 'mute', channels: ['surdo'], muted: false, aux: undefined });
    expect(p('master -3')).toEqual({ kind: 'master', db: -3 });
    expect(p('desfazer')).toEqual({ kind: 'undo', steps: 1 });
    expect(p('desfazer 2')).toEqual({ kind: 'undo', steps: 2 });
    expect(p('snapshots')).toEqual({ kind: 'snapshots' });
    expect(p('carrega Pagode / Bar')).toEqual({ kind: 'load', show: 'Pagode', snapshot: 'Bar' });
    expect(p('nomes')).toEqual({ kind: 'names' });
    expect(p('log')).toEqual({ kind: 'log' });
    expect(p('ajuda')).toEqual({ kind: 'help' });
    expect(p('sair')).toEqual({ kind: 'quit' });
    expect(p('')).toEqual({ kind: 'empty' });
  });

  it('número que faz parte do nome não vira valor ("voz 2" é o canal)', () => {
    expect(p('sobe voz 2')).toEqual({ kind: 'level', channel: 'voz 2', aux: undefined, deltaDB: 2 });
  });

  it('erros com mensagem, sem executar nada', () => {
    expect(p('nivel cavaco')).toMatchObject({ kind: 'error' });
    expect(p('master abc')).toMatchObject({ kind: 'error' });
    expect(p('carrega Pagode')).toMatchObject({ kind: 'error' });
    expect(p('xyz')).toMatchObject({ kind: 'error', message: expect.stringContaining('desconhecido') });
  });

  it('o HELP documenta todos os comandos', () => {
    for (const c of ['status', 'estado', 'sobe', 'desce', 'nivel', 'muta', 'abre', 'master', 'desfazer', 'snapshots', 'carrega', 'nomes', 'log']) {
      expect(HELP).toContain(c);
    }
  });
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChannelMap } from '../src/core/channels.js';
import { parseConfig } from '../src/core/config.js';
import { MixController } from '../src/core/controller.js';
import { ActionLog } from '../src/core/log.js';
import { paramKey } from '../src/core/revisions.js';
import { LabMixer } from '../src/mixer/lab.js';
import { LAB_SCHEMA_VERSION, LabStateVersionError } from '../src/mixer/lab-store.js';
import { MASTER } from '../src/mixer/types.js';
import { fixtureChannels } from './helpers.js';

const VOZ1 = paramKey.level(1, MASTER);

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-lab-'));
  return { dir, file: join(dir, 'lab-state.json') };
}

async function openLab(file: string, opts: { saveDebounceMs?: number } = {}) {
  const mixer = new LabMixer({ file, saveDebounceMs: opts.saveDebounceMs ?? 0 });
  await mixer.connect();
  const names = new ChannelMap(fixtureChannels(), mixer.capabilities());
  const controller = new MixController(mixer, parseConfig({}).safety, names, new ActionLog(null));
  return { mixer, controller };
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('LabMixer persistente', () => {
  it('sem arquivo: começa do estado padrão e só cria o arquivo na primeira mudança', async () => {
    const { file } = tmpFile();
    const { mixer } = await openLab(file);
    expect(mixer.loadResult.source).toBe('default');
    expect(existsSync(file)).toBe(false);
    expect(mixer.mode).toBe('lab');
    expect(mixer.statusText()).toContain('sem conexão com a mesa física');
  });

  it('mudanças sobrevivem ao reinício (nível, mute, AUX, EQ e snapshot atual)', async () => {
    const { file } = tmpFile();
    const a = await openLab(file);
    await a.controller.setLevel({ channel: 'voz 1', db: -8 });
    await a.controller.setMute({ channels: ['surdo'], muted: true });
    await a.controller.setLevel({ channel: 'voz 2', aux: 'cavaco', deltaDB: 3 });
    await a.mixer.write(paramKey.eqBand(4, 2, 'gain'), -3); // EQ: só no laboratório, sem tool ainda
    await a.mixer.write(paramKey.level(5, MASTER), -Infinity);
    await a.mixer.loadSnapshot('Laboratório', 'Bar');
    await a.mixer.disconnect(); // grava o pendente

    const b = await openLab(file);
    expect(b.mixer.loadResult.source).toBe('main');
    expect(b.mixer.read(VOZ1)).toEqual({ known: true, value: -8 });
    expect(b.mixer.read(paramKey.mute(6, MASTER))).toEqual({ known: true, value: true });
    expect(b.mixer.read(paramKey.level(2, { kind: 'aux', aux: 2 }))).toEqual({ known: true, value: -17 });
    expect(b.mixer.read(paramKey.eqBand(4, 2, 'gain'))).toEqual({ known: true, value: -3 });
    expect(b.mixer.read(paramKey.level(5, MASTER))).toEqual({ known: true, value: -Infinity });
    expect(await b.mixer.currentSnapshot()).toEqual({ show: 'Laboratório', snapshot: 'Bar' });
    const raw = readJson(file);
    expect(raw).toMatchObject({ schemaVersion: LAB_SCHEMA_VERSION, kind: 'mixai-lab-state', deviceProfile: 'ui16' });
    expect((raw.values as Record<string, unknown>)['ch.5.main.level']).toBe('-inf');
  });

  it('juntas várias mudanças seguidas numa gravação só (debounce) e grava ao sair', async () => {
    const { file } = tmpFile();
    const { mixer, controller } = await openLab(file, { saveDebounceMs: 10_000 });
    const save = vi.spyOn(mixer.store, 'save');
    for (let i = 0; i < 4; i++) await controller.setLevel({ channel: 'voz 1', deltaDB: 1 });
    expect(save).not.toHaveBeenCalled();
    mixer.flush();
    expect(save).toHaveBeenCalledTimes(1);
    mixer.flush(); // nada pendente: não grava de novo
    expect(save).toHaveBeenCalledTimes(1);
    expect((readJson(file).values as Record<string, unknown>)[VOZ1]).toBe(-6);
  });

  it('gravação atômica com backup: a versão anterior válida vira .bak', async () => {
    const { file } = tmpFile();
    const { mixer, controller } = await openLab(file);
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    mixer.flush();
    expect(existsSync(`${file}.bak`)).toBe(false); // primeira gravação: não havia versão anterior
    await controller.setLevel({ channel: 'voz 1', db: -7 });
    mixer.flush();
    expect((readJson(`${file}.bak`).values as Record<string, unknown>)[VOZ1]).toBe(-8);
    expect((readJson(file).values as Record<string, unknown>)[VOZ1]).toBe(-7);
    expect(readdirSync(join(file, '..')).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('principal corrompido: guarda como .corrupt, recupera do backup e avisa', async () => {
    const { dir, file } = tmpFile();
    const a = await openLab(file);
    await a.controller.setLevel({ channel: 'voz 1', db: -8 });
    a.mixer.flush();
    await a.controller.setLevel({ channel: 'voz 1', db: -7 });
    a.mixer.flush();
    writeFileSync(file, '{ isto não é JSON');

    const b = await openLab(file);
    expect(b.mixer.loadResult.source).toBe('backup');
    expect(b.mixer.read(VOZ1)).toEqual({ known: true, value: -8 });
    expect(b.mixer.loadResult.warnings.join(' ')).toMatch(/inválido.*corrupt/);
    expect(readdirSync(dir).some((n) => n.startsWith('lab-state.json.corrupt-'))).toBe(true);

    // A próxima gravação recria o principal sem estragar o backup bom.
    await b.controller.setLevel({ channel: 'voz 2', db: -9 });
    b.mixer.flush();
    expect((readJson(file).values as Record<string, unknown>)[VOZ1]).toBe(-8);
    expect((readJson(`${file}.bak`).values as Record<string, unknown>)[VOZ1]).toBe(-8);
  });

  it('principal e backup inválidos: estado padrão, com avisos, sem travar', async () => {
    const { file } = tmpFile();
    writeFileSync(file, '[]');
    writeFileSync(`${file}.bak`, '');
    const { mixer } = await openLab(file);
    expect(mixer.loadResult.source).toBe('default');
    expect(mixer.loadResult.warnings.length).toBeGreaterThanOrEqual(2);
    expect(mixer.read(VOZ1)).toEqual({ known: true, value: -10 });
  });

  it('valor fora da faixa no arquivo = arquivo inválido (não carrega pela metade)', async () => {
    const { file } = tmpFile();
    const a = await openLab(file);
    await a.controller.setLevel({ channel: 'voz 1', db: -8 });
    a.mixer.flush();
    const raw = readJson(file);
    (raw.values as Record<string, unknown>)['ch.1.eq.b1.gain'] = 99;
    writeFileSync(file, JSON.stringify(raw));
    const b = await openLab(file);
    expect(b.mixer.loadResult.source).toBe('default'); // sem backup ainda
    expect(b.mixer.loadResult.warnings.join(' ')).toMatch(/máximo/);
  });

  it('chaves desconhecidas são ignoradas e ausentes começam no padrão (com aviso)', async () => {
    const { file } = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'mixai-lab-state',
        deviceProfile: 'ui16',
        savedAt: new Date().toISOString(),
        values: { 'ch.1.main.level': -4, 'ch.99.main.level': 0, 'algo.estranho': 1 },
      }),
    );
    const { mixer } = await openLab(file);
    expect(mixer.loadResult.source).toBe('main');
    expect(mixer.read(VOZ1)).toEqual({ known: true, value: -4 });
    expect(mixer.read(paramKey.level(2, MASTER))).toEqual({ known: true, value: -10 });
    expect(mixer.loadResult.warnings.join(' ')).toMatch(/2 parâmetro\(s\) desconhecido/);
    expect(mixer.loadResult.warnings.join(' ')).toMatch(/ausente/);
  });

  it('perfil de mesa diferente é recusado (vai para backup/padrão)', async () => {
    const { file } = tmpFile();
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'mixai-lab-state', deviceProfile: 'ui24', savedAt: 'x', values: {} }));
    const { mixer } = await openLab(file);
    expect(mixer.loadResult.source).toBe('default');
    expect(mixer.loadResult.warnings.join(' ')).toMatch(/perfil de mesa diferente/);
  });

  it('arquivo de versão mais nova: recusa abrir e NÃO altera o arquivo', async () => {
    const { file } = tmpFile();
    const content = JSON.stringify({ schemaVersion: LAB_SCHEMA_VERSION + 1, kind: 'mixai-lab-state', values: {} });
    writeFileSync(file, content);
    expect(() => new LabMixer({ file })).toThrow(LabStateVersionError);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('gravação interrompida (temporário deixado para trás) não afeta o principal', async () => {
    const { dir, file } = tmpFile();
    const a = await openLab(file);
    await a.controller.setLevel({ channel: 'voz 1', db: -8 });
    a.mixer.flush();
    writeFileSync(join(dir, 'lab-state.json.tmp-123-456'), '{ meio arquivo');
    const b = await openLab(file);
    expect(b.mixer.loadResult.source).toBe('main');
    expect(b.mixer.read(VOZ1)).toEqual({ known: true, value: -8 });
    expect(b.mixer.loadResult.warnings.join(' ')).toMatch(/interrompida/);
    expect(readdirSync(dir).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('falha ao gravar: avisa, mantém o estado em memória e tenta de novo depois', async () => {
    const { dir, file } = tmpFile();
    const errors: string[] = [];
    const mixer = new LabMixer({ file, saveDebounceMs: 0, onSaveError: (e) => errors.push(e.message) });
    await mixer.connect();
    mkdirSync(file); // o caminho do arquivo virou uma pasta: rename falha
    await mixer.write(VOZ1, -8);
    mixer.flush();
    expect(errors.length).toBe(1);
    expect(mixer.statusText()).toContain('última gravação falhou');
    expect(mixer.read(VOZ1)).toEqual({ known: true, value: -8 });
    expect(readdirSync(dir).some((n) => n.includes('.tmp-'))).toBe(false); // temporário limpo
  });

  it('resetToDefaults volta ao estado inicial e grava', async () => {
    const { file } = tmpFile();
    const { mixer, controller } = await openLab(file);
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    mixer.resetToDefaults();
    mixer.flush();
    expect(mixer.read(VOZ1)).toEqual({ known: true, value: -10 });
    expect((readJson(file).values as Record<string, unknown>)[VOZ1]).toBe(-10);
  });

  it('valor inválido escrito direto no laboratório é recusado pelo registro', async () => {
    const { file } = tmpFile();
    const { mixer } = await openLab(file);
    await expect(mixer.write(paramKey.hpf(1, 'slope'), 18)).rejects.toThrow(/12\/24\/36/);
    await expect(mixer.write(paramKey.eqBand(1, 1, 'freq'), 5)).rejects.toThrow(/mínimo/);
  });

  it('as travas, a fila, o desfazer e as confirmações da E0 valem no laboratório', async () => {
    const { file } = tmpFile();
    const { controller } = await openLab(file);
    expect((await controller.setLevel({ channel: 'surdo', deltaDB: 10 })).code).toBe('NEEDS_CONFIRMATION');
    await controller.setLevel({ channel: 'voz 1', db: -8 });
    expect((await controller.undo()).code).toBe('OK');
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseChannels, parseConfig } from '../src/core/config.js';

// Registra se o módulo da mesa real foi carregado. O factory do vi.mock só roda quando
// alguém importa '../src/mixer/real.js'.
const probe = vi.hoisted(() => ({ realLoaded: 0 }));
vi.mock('../src/mixer/real.js', async (importOriginal) => {
  probe.realLoaded++;
  return importOriginal();
});

const { createApp } = await import('../src/core/app.js');

function loaded(mode: 'mock' | 'real') {
  return {
    config: parseConfig({ mixer: { mode, ip: '10.10.1.1' }, logs: { dir: null } }),
    channels: parseChannels({ channels: [{ number: 1, name: 'Voz', aliases: [] }], aux: [{ number: 1, name: 'Fones', aliases: [] }] }),
    configDir: '.',
    logDir: null,
  };
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

describe('isolamento LAB/mock × mesa real', () => {
  it('modo mock não carrega o código da mesa real nem abre WebSocket', async () => {
    const opened: string[] = [];
    globalThis.WebSocket = class {
      constructor(url: string) {
        opened.push(url);
        throw new Error('WebSocket não deveria ser usado no modo mock');
      }
    } as never;
    const app = await createApp(loaded('mock'));
    await app.controller.ensureConnected();
    await app.controller.setLevel({ channel: 1, deltaDB: 2 });
    await app.controller.mixState();
    expect(app.mixer.mode).toBe('mock');
    expect(probe.realLoaded).toBe(0);
    expect(opened).toEqual([]);
    await app.mixer.disconnect();
  });

  it('modo real carrega o módulo (prova de que o teste acima detectaria)', async () => {
    const app = await createApp(loaded('real'));
    expect(app.mixer.mode).toBe('real');
    expect(probe.realLoaded).toBe(1);
    expect(app.mixer.link()).toBe('DISCONNECTED'); // nada é aberto só por montar o app
    await app.mixer.disconnect();
  });

  it('não existe modo "legacy" de reconexão: a configuração é recusada', () => {
    expect(() => parseConfig({ mixer: { connection: { strategy: 'legacy' } } })).toThrow();
  });
});

describe('precedência da configuração', () => {
  function dirWith(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), 'mixai-cfg-'));
    writeFileSync(join(dir, 'config.yaml'), yaml);
    writeFileSync(join(dir, 'channels.yaml'), 'channels: []\naux: []\n');
    return dir;
  }
  const base = (dir: string, extra: Record<string, string> = {}) => ({ MIXAI_CONFIG_DIR: dir, MIXAI_LOG_DIR: '', ...extra });

  it('--real > --mock > MIXAI_MODE > config.yaml', () => {
    const dir = dirWith('mixer:\n  mode: real\n');
    expect(loadConfig(base(dir), []).config.mixer.mode).toBe('real');
    expect(loadConfig(base(dir, { MIXAI_MODE: 'mock' }), []).config.mixer.mode).toBe('mock');
    expect(loadConfig(base(dir, { MIXAI_MODE: 'real' }), ['--mock']).config.mixer.mode).toBe('mock');
    expect(loadConfig(base(dir, { MIXAI_MODE: 'mock' }), ['--mock', '--real']).config.mixer.mode).toBe('real');
  });

  it('MIXAI_IP substitui o IP do arquivo; allowUnmapped padrão é false', () => {
    const dir = dirWith('mixer:\n  ip: 10.10.1.1\n');
    const cfg = loadConfig(base(dir, { MIXAI_IP: '192.168.0.50' }), []).config;
    expect(cfg.mixer.ip).toBe('192.168.0.50');
    expect(cfg.naming.allowUnmapped).toBe(false);
  });
});

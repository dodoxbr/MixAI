import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseChannels, parseConfig } from '../src/core/config.js';

// Registra se o módulo da mesa real foi carregado. O factory do vi.mock só roda quando
// alguém importa '../src/mixer/real.js'.
const probe = vi.hoisted(() => ({ realLoaded: 0, libLoaded: 0 }));
vi.mock('../src/mixer/real.js', async (importOriginal) => {
  probe.realLoaded++;
  return importOriginal();
});
// Idem para a biblioteca da Soundcraft: o laboratório e o mock não podem nem carregá-la.
vi.mock('soundcraft-ui-connection', async (importOriginal) => {
  probe.libLoaded++;
  return importOriginal();
});

const { createApp } = await import('../src/core/app.js');

function loaded(mode: 'mock' | 'lab' | 'real') {
  return {
    config: parseConfig({ mixer: { mode, ip: '10.10.1.1' }, logs: { dir: null } }),
    channels: parseChannels({ channels: [{ number: 1, name: 'Voz', aliases: [] }], aux: [{ number: 1, name: 'Fones', aliases: [] }] }),
    configDir: '.',
    logDir: null,
    labFile: join(mkdtempSync(join(tmpdir(), 'mixai-iso-')), 'lab-state.json'),
  };
}

/** Falha o teste se qualquer coisa tentar abrir WebSocket ou socket TCP. */
function forbidNetwork() {
  const opened: string[] = [];
  globalThis.WebSocket = class {
    constructor(url: string) {
      opened.push(`ws:${url}`);
      throw new Error('WebSocket proibido neste modo');
    }
  } as never;
  const tcp = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
    opened.push('tcp');
    throw new Error('TCP proibido neste modo');
  });
  return { opened, restore: () => tcp.mockRestore() };
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

describe('isolamento LAB/mock × mesa real', () => {
  for (const mode of ['mock', 'lab'] as const) {
    it(`modo ${mode} não carrega o código da mesa real nem a biblioteca, e não abre rede`, async () => {
      const net = forbidNetwork();
      try {
        const cfg = loaded(mode);
        const app = await createApp(cfg);
        await app.controller.ensureConnected();
        await app.controller.setLevel({ channel: 1, deltaDB: 2 });
        await app.controller.setMute({ channels: [1], muted: true });
        await app.controller.undo();
        await app.controller.mixState();
        app.controller.state.snapshot();
        await app.mixer.disconnect();
        expect(app.mixer.mode).toBe(mode);
        expect(probe.realLoaded).toBe(0);
        expect(probe.libLoaded).toBe(0);
        expect(net.opened).toEqual([]);
        if (mode === 'lab') expect(existsSync(cfg.labFile)).toBe(true); // o laboratório persistiu
      } finally {
        net.restore();
      }
    });
  }

  it('laboratório com IP da mesa configurado continua sem rede', async () => {
    const net = forbidNetwork();
    try {
      const cfg = loaded('lab');
      cfg.config.mixer.ip = '10.10.1.1';
      const app = await createApp(cfg);
      await app.controller.ensureConnected();
      await app.controller.setLevel({ channel: 1, deltaDB: 1 });
      await app.mixer.disconnect();
      expect(net.opened).toEqual([]);
      expect(probe.realLoaded).toBe(0);
    } finally {
      net.restore();
    }
  });

  it('modo real carrega o módulo (prova de que o teste acima detectaria)', async () => {
    const app = await createApp(loaded('real'));
    expect(app.mixer.mode).toBe('real');
    expect(probe.realLoaded).toBe(1);
    expect(probe.libLoaded).toBe(1);
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

  it('--lab e MIXAI_MODE=lab; MIXAI_LAB_FILE define o arquivo', () => {
    const dir = dirWith('mixer:\n  mode: mock\nlab:\n  stateFile: data/x.json\n');
    expect(loadConfig(base(dir), ['--lab']).config.mixer.mode).toBe('lab');
    expect(loadConfig(base(dir, { MIXAI_MODE: 'lab' }), []).config.mixer.mode).toBe('lab');
    expect(loadConfig(base(dir), []).labFile).toMatch(/data[\\/]x\.json$/);
    const custom = join(dir, 'meu-lab.json');
    expect(loadConfig(base(dir, { MIXAI_LAB_FILE: custom }), []).labFile).toBe(custom);
  });

  it('--real > --mock > --lab > MIXAI_MODE > config.yaml', () => {
    const lab = dirWith('mixer:\n  mode: lab\n');
    expect(loadConfig(base(lab), ['--lab', '--mock']).config.mixer.mode).toBe('mock');
    expect(loadConfig(base(lab, { MIXAI_MODE: 'real' }), ['--lab']).config.mixer.mode).toBe('lab');
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

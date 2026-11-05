import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadConfig, mergeConfig, parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { NOT_INTERACTIVE, pinCommand } from '../src/pin-cli.js';
import { verifyPin } from '../src/server/pin.js';

/** Pasta de configuração temporária com o config.yaml REAL do repositório (+ local opcional). */
function configDir(local?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-local-'));
  copyFileSync(join(PROJECT_ROOT, 'config', 'config.yaml'), join(dir, 'config.yaml'));
  copyFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), join(dir, 'channels.yaml'));
  if (local !== undefined) writeFileSync(join(dir, 'config.local.yaml'), local);
  return dir;
}
const env = (dir: string, extra: Record<string, string> = {}) => ({ MIXAI_CONFIG_DIR: dir, MIXAI_LOG_DIR: '', ...extra });

describe('config.local.yaml (fora do Git)', () => {
  it('sobrescreve SÓ os campos declarados; o resto continua do config.yaml', () => {
    const repo = loadConfig(env(configDir()), []).config;
    const dir = configDir('server:\n  lan:\n    enabled: true\n    host: "192.168.0.20"\nsafety:\n  maxStepDB: 4\n');
    const { config, localConfigFile } = loadConfig(env(dir), []);
    expect(localConfigFile).toBe(join(dir, 'config.local.yaml'));
    expect(config.server.lan).toEqual({ enabled: true, host: '192.168.0.20' });
    expect(config.safety.maxStepDB).toBe(4);
    // tudo o que não foi declarado continua igual ao do repositório
    expect(config.safety.masterRequiresConfirmation).toBe(repo.safety.masterRequiresConfirmation);
    expect(config.safety.maxActionsPerSecond).toBe(repo.safety.maxActionsPerSecond);
    expect(config.server.musicianAux).toBe(repo.server.musicianAux);
    expect(config.server.musicianAccess).toBe('fones_only');
    expect(config.mixer).toEqual(repo.mixer);
    expect(config.ai).toEqual(repo.ai);
  });

  it('sem config.local.yaml, nada muda (e o padrão dos músicos é fones_only)', () => {
    const { config, localConfigFile } = loadConfig(env(configDir()), []);
    expect(localConfigFile).toBeUndefined();
    expect(config.server.lan.enabled).toBe(false);
    expect(config.server.musicianAccess).toBe('fones_only');
  });

  it('arquivo local vazio é aceito', () => {
    expect(loadConfig(env(configDir('# só comentários\n')), []).config.server.lan.enabled).toBe(false);
  });

  it('precedência: config.yaml < config.local.yaml < variáveis de ambiente < argumentos', () => {
    const dir = configDir('mixer:\n  mode: mock\n  ip: 10.0.0.9\nserver:\n  port: 9100\n  lan:\n    enabled: true\n    host: "192.168.0.20"\n');
    expect(loadConfig(env(dir), []).config).toMatchObject({ mixer: { mode: 'mock', ip: '10.0.0.9' }, server: { port: 9100 } });
    const e = env(dir, { MIXAI_MODE: 'lab', MIXAI_IP: '10.10.1.1', MIXAI_PORT: '9200', MIXAI_LAN_HOST: '192.168.1.77' });
    expect(loadConfig(e, []).config).toMatchObject({ mixer: { mode: 'lab', ip: '10.10.1.1' }, server: { port: 9200, lan: { enabled: true, host: '192.168.1.77' } } });
    expect(loadConfig(e, ['--real']).config.mixer.mode).toBe('real'); // argumento vence a variável
  });

  it('segredos no arquivo local são recusados (PIN e chave da API ficam separados)', () => {
    for (const bad of ['anthropicApiKey: abc\n', 'operatorPinHash: x\n', 'server:\n  pin: "1234"\n', 'ai:\n  apiKey: x\n']) {
      expect(() => loadConfig(env(configDir(bad)), []), bad).toThrow(/segredo/);
    }
  });

  it('valor inválido no arquivo local: erro que aponta o arquivo', () => {
    expect(() => loadConfig(env(configDir('server:\n  musicianAccess: tudo\n')), [])).toThrow(/config\.local\.yaml/);
    expect(() => loadConfig(env(configDir('- lista\n')), [])).toThrow(/mapa YAML/);
  });

  it('mesclagem: objetos campo a campo; listas e valores simples substituem', () => {
    expect(mergeConfig({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({ a: { b: 1, c: 3 }, l: [9] });
    expect(mergeConfig({ a: 1 }, null)).toEqual({ a: 1 });
  });

  it('o arquivo local está no .gitignore; o exemplo do repositório é válido e sem segredos', () => {
    expect(readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf8')).toMatch(/^config\/config\.local\.yaml$/m);
    const example = readFileSync(join(PROJECT_ROOT, 'config', 'config.local.example.yaml'), 'utf8');
    expect(() => parseConfig(mergeConfig({}, parse(example)))).not.toThrow();
    const dir = configDir(example);
    expect(loadConfig(env(dir), []).config.server.lan.enabled).toBe(true);
    // o exemplo não altera os nomes da banda
    expect(readFileSync(join(dir, 'channels.yaml'), 'utf8')).toBe(readFileSync(join(PROJECT_ROOT, 'config', 'channels.yaml'), 'utf8'));
  });
});

describe('npm run pin', () => {
  const io = (input: string, tty: boolean) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: tty });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (d) => (out += d));
    stderr.on('data', (d) => (err += d));
    if (input) stdin.end(input);
    return { io: { stdin, stdout, stderr }, out: () => out, err: () => err };
  };

  it('entrada não interativa (pipe): mensagem clara, código ≠ 0 e NADA gravado', async () => {
    const dir = configDir();
    const t = io('1234\n1234\n', false);
    const code = await pinCommand(['operador'], dir, t.io);
    expect(code).toBe(2);
    expect(t.err()).toBe(`${NOT_INTERACTIVE}\n`);
    expect(t.err()).toContain('terminal INTERATIVO');
    expect(existsSync(join(dir, 'secrets.yaml'))).toBe(false);
    expect(t.out() + t.err()).not.toContain('1234\n');
  });

  it('terminal: grava SÓ o hash; o PIN não aparece na saída nem no arquivo', async () => {
    const dir = configDir();
    const t = io('482913\n482913\n', true);
    expect(await pinCommand(['musico'], dir, t.io)).toBe(0);
    const text = readFileSync(join(dir, 'secrets.yaml'), 'utf8');
    expect(text).not.toContain('482913');
    expect(t.out()).not.toContain('482913');
    expect(verifyPin('482913', (parse(text) as { musicianPinHash: string }).musicianPinHash)).toBe(true);
  });

  it('entrada encerrada antes do PIN (Ctrl+D): avisa e não grava', async () => {
    const dir = configDir();
    const t = io('', true);
    t.io.stdin.end();
    expect(await pinCommand(['operador'], dir, t.io)).toBe(2);
    expect(t.err()).toContain('Nada foi gravado');
    expect(existsSync(join(dir, 'secrets.yaml'))).toBe(false);
  });

  it('perfil desconhecido: mostra o uso', async () => {
    const t = io('', true);
    expect(await pinCommand(['xyz'], configDir(), t.io)).toBe(1);
    expect(t.err()).toContain('Uso:');
  });
});

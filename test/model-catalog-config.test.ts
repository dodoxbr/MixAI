import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig, parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { externalUsageTracker } from '../src/knowledge/local/external-providers.js';
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'mixai-catalog-config-'));
  for (const file of ['config.yaml', 'channels.yaml']) copyFileSync(join(PROJECT_ROOT, 'config', file), join(dir, file));
  return dir;
}
it('catálogo desligado por padrão; IDs futuros aceitos sem alterar os modelos do caminho legado', () => {
  expect(parseConfig({}).modelCatalog).toMatchObject({ enabled: false, unknownPricePolicy: 'block' });
  const config = parseConfig({ modelCatalog: { providers: { openai: { models: ['custom-gpt-next'] }, ollama: { models: ['namespace/custom:tag'] } } } });
  expect(config.modelCatalog.providers.openai?.models).toEqual(['custom-gpt-next']);
  expect(config.knowledge.chatProvider).toBe('ollama');
});
it.each([
  { unknownPricePolicy: 'allow' }, { providers: { openai: { models: ['https://evil.invalid'] } } },
  { providers: { gemini: { models: ['namespace/model'] } } }, { providers: { openai: { prices: { model: { inputPerMTok: -1, outputPerMTok: 1 } } } } },
  { providers: { openai: { apiKey: 'FAKE_KEY' } } }, { maxOutputTokens: 1000000 },
])('configuração inválida falha fechada %#', modelCatalog => {
  expect(() => parseConfig({ modelCatalog })).toThrow();
});
it('chave OpenAI é lida só em secrets/ambiente e nunca integra a configuração pública', () => {
  const dir = folder(); writeFileSync(join(dir, 'secrets.yaml'), 'openaiApiKey: FAKE_FILE_KEY_123456\n');
  const base = { MIXAI_CONFIG_DIR: dir, MIXAI_LOG_DIR: '' };
  expect(loadConfig(base, []).secrets?.openaiApiKey).toBe('FAKE_FILE_KEY_123456');
  const loaded = loadConfig({ ...base, OPENAI_API_KEY: 'FAKE_OPENAI_ENV_KEY', MIXAI_OPENAI_API_KEY: 'FAKE_MIXAI_ENV_KEY' }, []);
  expect(loaded.secrets?.openaiApiKey).toBe('FAKE_MIXAI_ENV_KEY');
  expect(JSON.stringify(loaded.config)).not.toContain('FAKE_');
});
it.each(['openaiApiKey', 'OPENAI_API_KEY', 'MIXAI_OPENAI_API_KEY'])('não aceita %s no config.local.yaml', key => {
  const dir = folder(); writeFileSync(join(dir, 'config.local.yaml'), `${key}: FAKE_KEY_NOT_PUBLIC\n`);
  expect(() => loadConfig({ MIXAI_CONFIG_DIR: dir, MIXAI_LOG_DIR: '' }, [])).toThrow(/segredo/);
});
it('catálogo e wrapper legado compartilham o mesmo registro por caminho canônico', () => {
  const dir = folder(), a = externalUsageTracker(join(dir, 'ledger.json')), b = externalUsageTracker(resolve(dir, './ledger.json'));
  expect(a).toBe(b); expect(a.reserve(0.6, 1).ok).toBe(true);
  expect(b.reserve(0.6, 1).ok).toBe(false); expect(b.current().reservedUSD).toBe(0.6);
});

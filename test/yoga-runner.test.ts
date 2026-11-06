import { expect, it } from 'vitest';
import { smokeEnvironment, smokeOptions } from '../scripts/smoke-yoga.js';

it('ensaio ignora overrides REAL, credenciais e caminhos da máquina do operador', () => {
  const original = { PATH: 'path', MIXAI_MODE: 'real', MIXAI_IP: 'mesa', MIXAI_CONFIG_DIR: 'config-real',
    MIXAI_LAB_FILE: 'ensaio-do-operador', MIXAI_LAN_HOST: 'rede', MIXAI_OPERATOR_PIN_HASH: 'secreto',
    ANTHROPIC_API_KEY: 'segredo', OPENAI_API_KEY: 'segredo', CADDY_BIN: 'proxy' };
  const before = { ...original };
  expect(smokeEnvironment(original, 'temporario')).toEqual({ PATH: 'path', MIXAI_MODE: 'lab', MIXAI_SMOKE_DIR: 'temporario' });
  expect(original).toEqual(before);
});
it('nenhum argumento permite escolher REAL, IP, rede ou desabilitar os testes', () => {
  for (const args of [['--real'], ['--mode', 'real'], ['--ip=10.10.1.1'], ['--skip-tests'], ['--built', '--real']]) {
    expect(() => smokeOptions(args)).toThrow('Nenhuma opção REAL/rede');
  }
  expect(smokeOptions([])).toEqual({ built: false });
  expect(smokeOptions(['--built'])).toEqual({ built: true });
});

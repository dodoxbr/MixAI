import { afterEach, expect, it, vi } from 'vitest';
import { labRealFixture } from './support/lab-real-fixtures.js';

// Importar o comparador não pode sequer carregar a implementação de hardware.
vi.mock('../src/mixer/real.js', () => { throw new Error('RealMixer carregado durante comparação offline'); });
afterEach(() => vi.unstubAllGlobals());
it('importação e exportação offline não abrem WebSocket nem fazem fetch', async () => {
  const socket = vi.fn(function () { throw new Error('socket inesperado'); });
  const fetch = vi.fn(() => { throw new Error('rede inesperada'); });
  vi.stubGlobal('WebSocket', socket); vi.stubGlobal('fetch', fetch);
  const { compareLabReal, exportLabRealComparison } = await import('../src/core/lab-real-diff.js');
  const f = labRealFixture();
  expect(compareLabReal(f).totals.different).toBe(3);
  expect(exportLabRealComparison(f, 'markdown')).toContain('SOMENTE LEITURA');
  expect(socket).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

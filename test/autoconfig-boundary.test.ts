import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TechnicalPlanner, bandKnowledgeAdapter, autoConfigCases } from '../src/autoconfig/index.js';
import { RealMixer } from '../src/mixer/real.js';
import { MockMixer } from '../src/mixer/mock.js';
import { OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
const clients: Array<{ close(): void }> = [];
afterEach(async () => { clients.splice(0).forEach(c => c.close()); await Promise.all(servers.splice(0).map(t => t.server.close())); vi.restoreAllMocks(); });
it('proposta AutoConfig é só dado: não cria fila, builder, execute ou writes; ID não é aplicável pelo protocolo existente', async () => {
  const t = await startTestServer({ mode: 'mock' }); servers.push(t);
  const before = t.controller.state.snapshot(), execute = vi.spyOn(t.server.core, 'execute'), build = vi.spyOn(t.server.core.assistant!.builder, 'build'), real = vi.spyOn(RealMixer.prototype, 'write');
  const p = new TechnicalPlanner({ knowledge: bandKnowledgeAdapter(t.controller.names), policy: () => ({ enabled: true, active: true, selected: 'ollama', externalConsent: false, revision: 1 }) });
  // This legacy fixture has surdo on a different channel; resolve it from the authoritative map.
  const channel = t.controller.names.inputs.list().find(c => c.name === 'Surdo')!.number;
  const r = await p.plan({ ...autoConfigCases[0]!.input, channel }); expect(r.kind).toBe('proposal');
  if (r.kind !== 'proposal') throw new Error('expected proposal');
  const token = await t.login(OPERATOR_PIN), ws = await wsClient(t.base, token); clients.push(ws); await ws.next(m => m.type === 'snapshot');
  ws.send({ type: 'proposal_apply', requestId: 'forged-autoconfig', proposalId: r.proposal.id });
  expect((await ws.next(m => m.type === 'proposal_result')).status).toBe('not_found');
  expect((await t.http('/api/pending', { token })).json.items).toEqual([]);
  expect(execute).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled(); expect(real).not.toHaveBeenCalled(); expect((t.mixer as MockMixer).writes).toEqual([]); expect(t.controller.state.snapshot()).toEqual(before);
});
it('fronteira não importa mixer, serviço de diagnóstico, servidor, ferramentas ou mecanismos de execução', () => {
  for (const file of readdirSync('src/autoconfig').filter(n => n.endsWith('.ts'))) {
    const source = readFileSync(join('src/autoconfig', file), 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(m => m[2]!);
    expect(imports.some(i => /mixer|assistant|server|child_process|node:fs|local\/service/.test(i)), file).toBe(false);
    expect(source, file).not.toMatch(/\.(execute|write|apply)\(/);
  }
});

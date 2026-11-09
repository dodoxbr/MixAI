import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { enter, launch, startLab, physicalBandChannels, OPERATOR_PIN, PHONE, YOGA } from './harness.js';
let browser: Browser;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser.close(); });
async function api(page: Page, path: string, body: object) {
  return page.evaluate(async ({ path, body }) => {
    const res = await fetch(path, { method: 'POST', headers: { authorization: `Bearer ${sessionStorage.getItem('mixai.token')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  }, { path, body });
}
it.each([{ label: 'Yoga', device: YOGA }, { label: 'celular', device: PHONE }])('$label: M1 pela interface e conselho por API direta (contrato da rota; a tela é coberta em autoconfig-end-to-end)', async ({ device }) => {
  const t = await startLab({ channels: physicalBandChannels() });
  try {
    const { ctx, page } = await enter(browser, t.base, OPERATOR_PIN, device);
    const before = t.controller.state.snapshot(), write = vi.spyOn(t.mixer, 'write'), execute = vi.spyOn(t.server.core, 'execute');
    await page.getByPlaceholder('O que você deseja ajustar?').fill('Fred está abafado só no retorno, também sozinho.');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.technical-text').last().filter({ hasText: 'Fred' }).waitFor({ state: 'attached' });
    await page.locator('.technical-details').last().locator('summary').click();
    await page.locator('.technical-text').last().filter({ hasText: 'Fred' }).waitFor();
    const response = await api(page, '/api/autoconfig/suggestions', { serverId: t.server.core.serverId, scope: 'AUX1' });
    expect(response.status).toBe(200); expect(response.json.advice.kind).toBe('proposal');
    expect(response.json.advice.proposal.channel).toBe(3); expect(response.json.advice.proposal.destination).toBe('fones');
    expect(response.json.proposal.items[0].deltaDB).toBeUndefined(); expect(response.json.createsDraft).toBe(false);
    expect(response.json.advice.question).toBeUndefined();
    expect(await page.locator('.proposal').count()).toBe(0);
    expect(write).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(t.controller.state.snapshot()).toEqual(before);
    await ctx.close();
  } finally { await t.server.close(); }
});

it('caminho manual (sem planejador): UI B autoriza no núcleo D sem consultar C nem herdar a inspeção', async () => {
  const t = await startLab({ channels: physicalBandChannels() });
  try {
    const { ctx, page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
    const before = t.controller.state.snapshot();
    const write = vi.spyOn(t.mixer, 'write'), execute = vi.spyOn(t.server.core, 'execute');
    // Direct API probes establish that C is available. They are NOT UI consumption.
    await page.getByPlaceholder('O que você deseja ajustar?').fill('Fred está abafado no retorno');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('.technical-text').last().filter({ hasText: 'Fred' }).waitFor({ state: 'attached' });
    const suggest = (extra: object = {}) => api(page, '/api/autoconfig/suggestions', { serverId: t.server.core.serverId, scope: 'AUX1', ...extra });
    let response = await suggest();
    expect(response.status).toBe(200);
    expect(response.json.advice.question.field).toBe('comparison');
    response = await suggest({ answer: { inputFingerprint: response.json.advice.inputFingerprint, value: 'target_only' } });
    expect(response.status).toBe(200);
    expect(response.json.advice.question.field).toBe('isolation');
    response = await suggest({ answer: { inputFingerprint: response.json.advice.inputFingerprint, value: 'ensemble' } });
    expect(response.status).toBe(200);
    expect(response.json.advice.kind).toBe('proposal');
    const inspection = response.json.advice.proposal.suggestions[0];
    expect(inspection.kind).toBe('inspection');
    expect(inspection.targetValue).toBeNull();
    expect(response.json.proposal.items[0].deltaDB).toBeUndefined();
    expect(response.json.createsDraft).toBe(false);

    // From here only actual UI interactions are traced. No adapter mocks or API injection.
    const requests: Array<{ path: string; body: any }> = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/autoconfig') || path === '/api/command') {
        requests.push({ path, body: request.method() === 'POST' ? request.postDataJSON() : undefined });
      }
    });
    await page.getByRole('button', { name: 'Passagem de som', exact: true }).click();
    await page.getByLabel('Nome do evento da passagem', { exact: true }).fill('Integração parcial C B D');
    await page.getByLabel('Data da passagem', { exact: true }).fill('2026-11-09');
    await page.getByLabel('Operador da passagem', { exact: true }).fill('Operador LAB');
    await page.getByRole('button', { name: 'Iniciar passagem LAB', exact: true }).click();
    const auto = page.locator('mx-autoconfig');
    await auto.getByRole('button', { name: 'Definir teste manualmente (sem planejador)', exact: true }).click();
    // B still asks its own wizard questions, even though M1 and C already know the context.
    await auto.getByRole('button', { name: 'Melhorar clareza', exact: true }).click();
    await auto.getByLabel('Canal do AutoConfig', { exact: true }).selectOption('3');
    await auto.getByRole('button', { name: 'Confirmar canal', exact: true }).click();
    await auto.getByRole('button', { name: 'FONES · AUX1 compartilhado', exact: true }).click();
    await auto.getByLabel('Relato do AutoConfig', { exact: true }).fill('Fred abafado no retorno');
    const create = auto.getByRole('button', { name: 'Visualizar plano LAB', exact: true });
    expect(await auto.getByLabel('Passo virtual em dB', { exact: true }).inputValue()).toBe('0');
    expect(await create.isDisabled()).toBe(true);
    expect(requests.some(r => r.path === '/api/autoconfig' && r.body)).toBe(false);
    // Explicit human test input, unrelated to C's inspection; no inferred recommendation.
    await auto.getByLabel('Passo virtual em dB', { exact: true }).fill('0.5');
    await create.click();
    await auto.getByRole('heading', { name: 'Revise cada teste', exact: true }).waitFor();
    const draft = requests.find(r => r.path === '/api/autoconfig' && r.body)!.body;
    expect(draft.items[0]).toMatchObject({ channel: 3, deltaDB: 0.5, rationale: 'Teste virtual definido pelo operador; não é recomendação acústica da IA.' });
    expect(draft.items[0].id).not.toBe(response.json.proposal.items[0].id);
    expect(await auto.textContent()).not.toContain(inspection.candidate.instruction);
    await auto.getByRole('button', { name: 'Preparar contexto no servidor (descarta aprovações)', exact: true }).click();
    const approve = auto.getByRole('button', { name: 'Solicitar autorização deste teste LAB', exact: true });
    await approve.waitFor();
    expect(await auto.getByRole('button', { name: 'Executar este teste simulado', exact: true }).count()).toBe(0);
    await approve.click();
    await auto.getByRole('button', { name: 'Executar este teste simulado', exact: true }).click();
    await auto.getByText('Resultado SIMULADO — acústica não validada', { exact: true }).waitFor();
    await auto.getByRole('button', { name: 'Confirmar resultado simulado', exact: true }).click();
    await auto.getByRole('status').filter({ hasText: 'Confirmado como cenário simulado' }).waitFor();
    expect(requests.filter(r => r.body?.action).map(r => r.body.action)).toEqual(['prepare', 'approve', 'simulate', 'review']);
    const approval = requests.find(r => r.body?.action === 'approve')!.body;
    expect(approval).toMatchObject({ confirmed: true, scope: 'simulation_only' });
    expect(approval.digest).toEqual(expect.any(String));
    expect(requests.find(r => r.body?.action === 'simulate')!.body.approvalId).toEqual(expect.any(String));
    expect(requests.some(r => r.path === '/api/autoconfig/suggestions')).toBe(false);
    expect(requests.some(r => r.path === '/api/command')).toBe(false);
    expect(write).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(t.controller.state.snapshot()).toEqual(before);
    await ctx.close();
  } finally { await t.server.close(); }
});

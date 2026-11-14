import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { auxBus, MASTER } from '../../src/mixer/types.js';
import { bandChannels, enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab } from './harness.js';

type Lab = Awaited<ReturnType<typeof startLab>>;
let browser: Browser;
const labs: Lab[] = [];
const contexts: Array<{ close: () => Promise<void> }> = [];
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  for (const l of labs.splice(0)) await l.server.close();
});

async function lab(opts: Parameters<typeof startLab>[0] = {}) {
  const l = await startLab({ channels: bandChannels(), ...opts });
  labs.push(l);
  return l;
}
async function open(l: Lab, pin: string, device?: object) {
  const r = await enter(browser, l.base, pin, device);
  contexts.push(r.ctx);
  return r.page;
}
async function say(page: Page, text: string) {
  await page.getByPlaceholder('O que você deseja ajustar?').fill(text);
  await page.getByRole('button', { name: 'Enviar' }).click();
}
const v = (l: Lab, key: string) => (l.mixer.read(key as never) as { value?: unknown }).value;
const lastCard = (page: Page) => page.locator('.proposal').last();

/** Resposta simulada da Anthropic (nenhum crédito real). */
const anthropic = (input: unknown) =>
  new Response(
    JSON.stringify({
      model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id: 't', name: 'propor_ajuste', input }],
      usage: { input_tokens: 850, output_tokens: 70 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('assistente na tela (LAB, navegador real)', () => {
  it('Yoga e celular sincronizados após alterações feitas pelo assistente', async () => {
    const l = await lab();
    const yoga = await open(l, OPERATOR_PIN);
    const phone = await open(l, MUSICIAN_PIN, PHONE);

    // Operador, no Yoga, pelo assistente: cartão primeiro, nada muda até Aplicar
    await say(yoga, 'sobe o cavaco nos fones');
    await lastCard(yoga).waitFor();
    expect(await lastCard(yoga).textContent()).toContain('FONES');
    expect(v(l, paramKey.level(1, auxBus(1)))).toBe(-20);
    await lastCard(yoga).getByRole('button', { name: 'Confirmar ajuste' }).click();
    await expect.poll(() => v(l, paramKey.level(1, auxBus(1)))).toBe(-18);
    await expect.poll(() => phone.getByTestId('fones-value-1').textContent()).toContain('−18.0 dB'); // o celular viu

    // Músico, no celular: "sobe o surdo" → FONES (o único destino dele) → Yoga acompanha
    await say(phone, 'sobe o surdo');
    await lastCard(phone).getByRole('button', { name: 'Confirmar ajuste' }).click();
    await expect.poll(() => v(l, paramKey.level(9, auxBus(1)))).toBe(-18);
    await yoga.getByRole('tab', { name: 'AUX SENDS' }).click();
    await expect.poll(() => yoga.locator('.strips .strip-value').nth(8).textContent()).toContain('−18.0 dB');

    // "Melhorou? Não, voltar" no celular → nova proposta → volta ao valor anterior
    await phone.getByRole('button', { name: 'Não, voltar' }).click();
    await lastCard(phone).getByRole('button', { name: 'Confirmar ajuste' }).click();
    await expect.poll(() => v(l, paramKey.level(9, auxBus(1)))).toBe(-20);
    await expect.poll(() => yoga.locator('.strips .strip-value').nth(8).textContent()).toContain('−20.0 dB');
  });

  it('ambíguo: pergunta PA ou FONES com botões; a escolha vira proposta', async () => {
    const l = await lab();
    const yoga = await open(l, OPERATOR_PIN);
    await say(yoga, 'Aumenta um pouco o surdo.');
    await yoga.locator('.assist-options').getByRole('button', { name: 'PA', exact: true }).click();
    await lastCard(yoga).waitFor();
    expect(await lastCard(yoga).textContent()).toContain('−8.0 dB');
    expect(v(l, paramKey.level(9, MASTER))).toBe(-10);
  });

  it('master pelo assistente: Aplicar → cartão de aprovação da E2 → Aprovar', async () => {
    const l = await lab();
    const yoga = await open(l, OPERATOR_PIN);
    await say(yoga, 'abaixa o master 2 db');
    await lastCard(yoga).getByRole('button', { name: 'Confirmar ajuste' }).click();
    const approval = yoga.locator('mx-pending-cards .card');
    await approval.waitFor();
    expect(v(l, paramKey.master())).toBe(-6);
    await approval.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => v(l, paramKey.master())).toBe(-8);
  });

  it('músico pedindo PA pelo assistente: recusado com explicação', async () => {
    const l = await lab();
    const phone = await open(l, MUSICIAN_PIN, PHONE);
    await say(phone, 'sobe o surdo no PA');
    await phone.locator('.tone-error').waitFor();
    expect(await phone.locator('.tone-error').textContent()).toContain('PA e master são do operador');
    expect(v(l, paramKey.level(9, MASTER))).toBe(-10);
  });

  it('IA (simulada): pedido vago vira proposta com motivo; a mesa segue funcionando se a IA cair', async () => {
    let mode: 'ok' | 'down' = 'ok';
    const l = await lab({
      ai: { enabled: true, timeoutMs: 2000 },
      aiKey: 'sk-ant-teste',
      aiFetch: async () => {
        if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        return anthropic({ acao: 'propor', propostas: [{ tipo: 'volume', canal: 1, destino: 'PA', delta_db: 2, motivo: 'O cavaco está sumindo atrás do surdo' }] });
      },
    });
    const yoga = await open(l, OPERATOR_PIN);
    expect(await yoga.locator('.assist-mode').count()).toBe(0); // painel fechado até usar
    await say(yoga, 'preciso organizar melhor o cavaco na mix');
    await lastCard(yoga).waitFor();
    expect(await yoga.locator('.assist-mode').textContent()).toContain('IA ligada');
    expect(await lastCard(yoga).textContent()).toContain('O cavaco está sumindo atrás do surdo');
    expect(await lastCard(yoga).locator('.assist-src').textContent()).toContain('IA'); // origem visível no cartão
    expect(v(l, paramKey.level(1, MASTER))).toBe(-10);

    mode = 'down';
    await say(yoga, 'agora tá tudo estranho');
    await yoga.locator('.tone-error').waitFor();
    expect(await yoga.locator('.tone-error').textContent()).toContain('temporariamente indisponíveis');
    // a mesa continua: MUTE funciona normalmente
    await yoga.locator('.strips mx-strip').nth(10).getByRole('button', { name: 'MUTE' }).click();
    await expect.poll(() => v(l, paramKey.mute(11, MASTER))).toBe(true);
  });
});

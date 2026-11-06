import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { paramKey } from '../../src/core/revisions.js';
import { auxBus, MASTER } from '../../src/mixer/types.js';
import { bandChannels, enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab, YOGA } from './harness.js';

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
async function lab() {
  const l = await startLab({ channels: bandChannels() });
  labs.push(l);
  return l;
}
async function open(l: Lab, pin = OPERATOR_PIN, device: object = YOGA) {
  const r = await enter(browser, l.base, pin, device);
  contexts.push(r.ctx);
  const errors: string[] = [];
  r.page.on('pageerror', (e) => errors.push(e.message));
  return { page: r.page, errors };
}
const v = (l: Lab, key: string) => (l.mixer.read(key as never) as { value?: unknown }).value;
const SURDO = paramKey.level(9, MASTER);
const FERNANDO_FONES = paramKey.level(6, auxBus(1));

async function saveViaUi(page: Page, name: string, description = '') {
  await page.getByRole('button', { name: 'Salvar estado atual' }).click();
  await page.getByRole('textbox', { name: 'Nome' }).fill(name);
  if (description) await page.getByRole('textbox', { name: 'Descrição (opcional)' }).fill(description);
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.locator('.scene-item', { hasText: name }).waitFor();
}

describe('Cenas na tela do Yoga (LAB, navegador real)', () => {
  it('salvar → comparar → pedir → aprovar no cartão: só então o laboratório muda; desfazer volta tudo', async () => {
    const l = await lab();
    const { page, errors } = await open(l);
    const op = await l.login(OPERATOR_PIN);
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -12 });
    await l.command(op, { type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -17 });
    await page.getByRole('button', { name: 'Cenas' }).click();
    await page.getByText('Não são os snapshots da Soundcraft').waitFor(); // distinção clara
    await saveViaUi(page, 'Roda de sábado', 'surdo à frente');
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -15 });
    await l.command(op, { type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -20 });

    // Carregar fica desabilitado com o motivo até comparar
    expect(await page.getByRole('button', { name: 'Carregar…' }).isDisabled()).toBe(true);
    await page.getByText('Para carregar, toque em Comparar primeiro.').waitFor();
    await page.getByRole('button', { name: 'Comparar' }).click();
    const total = page.getByTestId('compare-total');
    await expect.poll(() => total.textContent()).toContain('2 alteração(ões) a aplicar');
    const rows = await page
      .locator('.scene-compare tbody tr')
      .evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent!.trim()).join(' ')));
    expect(rows).toEqual(['Surdo PA −15.0 dB −12.0 dB +3 dB', 'Voz Fernando FONES −20.0 dB −17.0 dB +3 dB']);
    // filtros por destino
    await page.locator('mx-scenes').getByRole('tab', { name: /FONES/ }).click();
    await expect.poll(() => page.locator('.scene-compare tbody tr').count()).toBe(1);
    await page.locator('mx-scenes').getByRole('tab', { name: /Todos/ }).click();

    await page.getByRole('button', { name: 'Carregar…' }).click();
    await page.getByRole('dialog', { name: 'Carregar cena no laboratório' }).getByText('2 parâmetro(s)').waitFor();
    await page.getByRole('button', { name: 'Pedir carregamento' }).click();
    const card = page.getByTestId('scene-load-card');
    await card.waitFor();
    expect([v(l, SURDO), v(l, FERNANDO_FONES)]).toEqual([-15, -20]); // nada mudou ainda
    await card.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => v(l, SURDO)).toBe(-12);
    expect(v(l, FERNANDO_FONES)).toBe(-17);
    // a tela compara de novo sozinha: nada mais a aplicar
    await expect.poll(() => total.textContent()).toContain('0 alteração(ões) a aplicar');

    // fechar o painel devolve os faders; um Desfazer volta a cena inteira
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.locator('mx-scenes').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect.poll(() => [v(l, SURDO), v(l, FERNANDO_FONES)]).toEqual([-15, -20]);
    expect(errors).toEqual([]);
  });

  it('mesa mudou depois do pedido: o cartão some, nada é aplicado e a tela pede nova comparação', async () => {
    const l = await lab();
    const { page } = await open(l);
    const op = await l.login(OPERATOR_PIN);
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -12 });
    await page.getByRole('button', { name: 'Cenas' }).click();
    await saveViaUi(page, 'Show');
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -15 });
    await page.getByRole('button', { name: 'Comparar' }).click();
    await page.getByRole('button', { name: 'Carregar…' }).click();
    await page.getByRole('button', { name: 'Pedir carregamento' }).click();
    await page.getByTestId('scene-load-card').waitFor();
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -14 }); // alguém mexeu
    await page.getByTestId('scene-load-card').waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('.toast').filter({ hasText: 'invalidada' }).waitFor();
    expect(v(l, SURDO)).toBe(-14); // a mudança posterior não foi sobrescrita
    await expect.poll(() => page.locator('.scene-compare tbody tr').first().textContent()).toContain('−14.0 dB');
  });

  it('exporta no "ROG" e importa no "Yoga" (dois servidores, duas pastas): nada aplicado na importação', async () => {
    const rog = await lab();
    const rogPage = (await open(rog)).page;
    const op = await rog.login(OPERATOR_PIN);
    await rog.command(op, { type: 'set_level', channel: 'surdo', db: -4 });
    await rogPage.getByRole('button', { name: 'Cenas' }).click();
    await saveViaUi(rogPage, 'Preparada no ROG');
    const [download] = await Promise.all([rogPage.waitForEvent('download'), rogPage.getByRole('button', { name: 'Exportar' }).click()]);
    expect(download.suggestedFilename()).toBe('mixai-cena-preparada-no-rog.json');
    const pendrive = mkdtempSync(join(tmpdir(), 'mixai-pendrive-'));
    const file = join(pendrive, download.suggestedFilename());
    await download.saveAs(file);

    const yoga = await lab();
    expect(yoga.dir).not.toBe(rog.dir);
    const { page, errors } = await open(yoga);
    await page.getByRole('button', { name: 'Cenas' }).click();
    await page.getByTestId('scene-import-input').setInputFiles(file);
    await page.getByTestId('scenes-notice').filter({ hasText: 'Nada foi aplicado' }).waitFor();
    await page.locator('.scene-item', { hasText: 'Preparada no ROG' }).waitFor();
    expect(v(yoga, SURDO)).toBe(-10); // importar não aplica
    await page.getByRole('button', { name: 'Comparar' }).click();
    await expect.poll(() => page.getByTestId('compare-total').textContent()).toContain('1 alteração(ões) a aplicar');
    expect(errors).toEqual([]);

    // arquivo inválido: erro visível, nada importado
    const bad = join(pendrive, 'quebrado.json');
    writeFileSync(bad, readFileSync(file, 'utf8').replace('"schemaVersion": 2', '"schemaVersion": 9'));
    await page.getByTestId('scene-import-input').setInputFiles(bad);
    await page.getByTestId('scenes-notice').filter({ hasText: 'versão mais nova do MixAI' }).waitFor();
    expect(await page.locator('.scene-item').count()).toBe(1);
  });

  it('duplicar, renomear e excluir (com confirmação) pela tela', async () => {
    const l = await lab();
    const { page } = await open(l);
    await page.getByRole('button', { name: 'Cenas' }).click();
    await saveViaUi(page, 'Pagode');
    await page.getByRole('button', { name: 'Duplicar' }).click();
    await page.locator('.scene-item', { hasText: 'Pagode (cópia)' }).waitFor();
    await page.getByRole('button', { name: 'Renomear' }).click();
    await page.getByRole('textbox', { name: 'Nome' }).fill('Samba de roda');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.locator('.scene-item', { hasText: 'Samba de roda' }).waitFor();
    // nome repetido: erro visível, diálogo continua aberto
    await page.getByRole('button', { name: 'Renomear' }).click();
    await page.getByRole('textbox', { name: 'Nome' }).fill('pagode');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.getByTestId('scenes-notice').filter({ hasText: 'Já existe uma cena' }).waitFor();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Excluir', exact: true }).click();
    await page.getByRole('dialog', { name: 'Excluir cena' }).getByText('Samba de roda').waitFor();
    await page.getByRole('dialog', { name: 'Excluir cena' }).getByRole('button', { name: 'Excluir' }).click();
    await expect.poll(() => page.locator('.scene-item').allTextContents()).toEqual([expect.stringContaining('Pagode')]);
  });

  it('músico não vê Cenas (nem no celular); o servidor recusa mesmo pelo WebSocket', async () => {
    const l = await startLab({ channels: bandChannels(), server: { musicianAccess: 'pa_without_master' } });
    labs.push(l);
    const { page } = await open(l, MUSICIAN_PIN, PHONE);
    expect(await page.getByRole('button', { name: 'Cenas' }).count()).toBe(0);
    const codes = await page.evaluate(async () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      const msgs: Array<Record<string, unknown>> = [];
      await new Promise((r) => (ws.onopen = r));
      ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: 'auth', token: sessionStorage.getItem('mixai.token') }));
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: 'command', requestId: 'm1', command: { type: 'scene_list' } }));
      ws.send(JSON.stringify({ type: 'command', requestId: 'm2', command: { type: 'scene_load', id: 'cena-abcdef', previewId: 'x' } }));
      await new Promise((r) => setTimeout(r, 400));
      ws.close();
      return msgs.filter((m) => m.type === 'result').map((m) => (m.result as { code: string }).code);
    });
    expect(codes).toEqual(['FORBIDDEN', 'FORBIDDEN']);
  });

  it('tela estreita (Yoga em retrato): lista, detalhes e comparação acessíveis, sem rolagem horizontal', async () => {
    const l = await lab();
    const { page } = await open(l, OPERATOR_PIN, { viewport: { width: 760, height: 1100 }, hasTouch: true });
    await page.getByRole('button', { name: 'Cenas' }).click();
    await saveViaUi(page, 'Retrato');
    await page.getByRole('button', { name: 'Comparar' }).click();
    await page.getByTestId('compare-total').waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of ['Comparar', 'Duplicar', 'Renomear', 'Exportar']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(44); // alvo de toque
    }
  });

  it('confirmação mostra TODOS os destinos: PA, FONES e outro AUX identificado (AUX 2), e aplica tudo só após aprovar', async () => {
    // Um segundo retorno cadastrado SÓ neste teste (o config/channels.yaml da banda não muda).
    const channels = bandChannels();
    channels.aux.push({ number: 2, name: 'Monitor do Fred', aliases: ['monitor fred'] });
    const l = await startLab({ channels });
    labs.push(l);
    const { page, errors } = await open(l);
    const op = await l.login(OPERATOR_PIN);
    const AUX2 = paramKey.level(1, auxBus(2));
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -12 });
    await l.command(op, { type: 'set_mute', channels: ['pandeiro'], muted: true });
    await l.command(op, { type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -17 });
    await l.command(op, { type: 'set_level', channel: 'cavaco', aux: 2, db: -15 });
    await page.getByRole('button', { name: 'Cenas' }).click();
    await saveViaUi(page, 'Três destinos');
    await l.command(op, { type: 'set_level', channel: 'surdo', db: -15 });
    await l.command(op, { type: 'set_mute', channels: ['pandeiro'], muted: false });
    await l.command(op, { type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -20 });
    await l.command(op, { type: 'set_level', channel: 'cavaco', aux: 2, db: -20 });

    await page.getByRole('button', { name: 'Comparar' }).click();
    await expect.poll(() => page.getByTestId('compare-total').textContent()).toContain('4 alteração(ões) a aplicar');
    // a comparação detalhada continua mostrando o AUX 2 pelo número
    await page.locator('.scene-compare tbody tr', { hasText: 'AUX 2 · Monitor do Fred' }).waitFor();

    await page.getByRole('button', { name: 'Carregar…' }).click();
    const items = await page
      .getByTestId('load-summary')
      .locator('li')
      .evaluateAll((lis) => lis.map((li) => [...li.children].map((c) => c.textContent!.replace(/\s+/g, ' ').trim()).join(' | ')));
    expect(items).toEqual([
      'PA | 2 alteração(ões) (1 volume, 1 mute) — Pandeiro, Surdo',
      'FONES | 1 alteração(ões) (1 volume) — Voz Fernando',
      'AUX 2 · Monitor do Fred | 1 alteração(ões) (1 volume) — Cavaco',
    ]);
    await page.getByRole('dialog', { name: 'Carregar cena no laboratório' }).getByText('4 parâmetro(s)').waitFor();
    await page.getByRole('dialog', { name: 'Carregar cena no laboratório' }).getByText('3 destino(s)').waitFor();
    await page.getByRole('button', { name: 'Pedir carregamento' }).click();
    const card = page.getByTestId('scene-load-card');
    await card.waitFor();
    expect([v(l, SURDO), v(l, FERNANDO_FONES), v(l, AUX2)]).toEqual([-15, -20, -20]); // nada ainda
    await card.getByRole('button', { name: 'Aprovar' }).click();
    await expect.poll(() => [v(l, SURDO), v(l, paramKey.mute(7, MASTER)), v(l, FERNANDO_FONES), v(l, AUX2)]).toEqual([-12, true, -17, -15]);
    expect(errors).toEqual([]);
  });

  it('cena de outro equipamento copiada direto para data/scenes: aparece como incompatível e não pode ser usada', async () => {
    const l = await lab();
    const { page } = await open(l);
    const op = await l.login(OPERATOR_PIN);
    const saved = (await l.command(op, { type: 'scene_save', name: 'Base' })).json.result.data.scene;
    const json = JSON.parse((await l.command(op, { type: 'scene_export', id: saved.id })).json.result.data.json);
    writeFileSync(join(l.dir, 'scenes', 'cena-ui24manual.json'), JSON.stringify({ ...json, id: 'cena-ui24manual', name: 'Do bar', deviceProfile: { model: 'ui24', inputs: 24, aux: 10 } }));
    await page.getByRole('button', { name: 'Cenas' }).click();
    const box = page.getByTestId('scenes-invalid');
    await box.waitFor();
    expect(await box.textContent()).toContain('cena-ui24manual.json');
    expect(await box.textContent()).toContain('cena de outro equipamento');
    expect(await box.textContent()).toContain('UI24');
    expect(await page.locator('.scene-item').allTextContents()).toEqual([expect.stringContaining('Base')]);
  });
});

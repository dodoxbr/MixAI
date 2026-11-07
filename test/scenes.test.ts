import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { parseChannels, parseConfig, PROJECT_ROOT } from '../src/core/config.js';
import { ChannelMap } from '../src/core/channels.js';
import { ActionLog } from '../src/core/log.js';
import { MixController } from '../src/core/controller.js';
import { paramKey } from '../src/core/revisions.js';
import { deviceProfileOf } from '../src/core/scene.js';
import { SceneStore } from '../src/core/scene-store.js';
import { MockMixer } from '../src/mixer/mock.js';
import { auxBus, MASTER } from '../src/mixer/types.js';
import { ScenesService } from '../src/server/scenes.js';
import { DEFAULT_POLICY } from '../src/server/policy.js';
import { MUSICIAN_PIN, OPERATOR_PIN, startTestServer, wsClient } from './server-support.js';

/**
 * E5 — Cenas do MixAI no LABORATÓRIO. Regra fundamental: NENHUMA cena altera a mesa sem
 * confirmação humana (comparar → pedir → pendência da E2 → aprovar → fila única).
 */
const band = () => parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'test', 'fixtures', 'legacy-channels.yaml'), 'utf8')));
type T = Awaited<ReturnType<typeof startTestServer>>;
const running: T[] = [];
const clients: Array<{ close: () => void }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of running.splice(0)) await t.server.close().catch(() => undefined);
});
async function start(extra: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({ channels: band(), ...extra });
  running.push(t);
  return t;
}
async function screen(t: T, pin = OPERATOR_PIN) {
  const c = await wsClient(t.base, await t.login(pin));
  clients.push(c);
  await c.next((m) => m.type === 'snapshot');
  const cmd = async (command: Record<string, unknown>) => (await c.request({ type: 'command', command })).result;
  const approve = async (pendingId: string) => (await c.request({ type: 'approve', pendingId })).result;
  /** Comando que pode pedir aprovação: aprova na hora (só para preparar o estado do teste). */
  const force = async (command: Record<string, unknown>) => {
    const r = await cmd(command);
    return r.pendingId ? approve(r.pendingId) : r;
  };
  return { c, cmd, approve, force };
}
const v = (t: T, key: string) => (t.mixer.read(key as never) as { value?: unknown }).value;
const PA = (ch: number) => paramKey.level(ch, MASTER);
const FONES = (ch: number) => paramKey.level(ch, auxBus(1));
const tick = (ms = 1300) => new Promise((r) => setTimeout(r, ms));

/** Salva, compara e pede o carregamento: devolve o resultado do pedido (normalmente uma pendência). */
async function compareAndRequest(op: Awaited<ReturnType<typeof screen>>, id: string) {
  const cmp = await op.cmd({ type: 'scene_compare', id });
  expect(cmp.code).toBe('OK');
  return { cmp, req: await op.cmd({ type: 'scene_load', id, previewId: cmp.data.previewId }) };
}

describe('cenas: criar, persistir, duplicar, renomear, excluir', () => {
  it('1. cria a cena a partir do estado atual, com o formato versionado e −∞ sem perda', async () => {
    const t = await start();
    const op = await screen(t);
    await op.force({ type: 'set_level', channel: 'tantã', db: -100 }); // −∞
    await op.cmd({ type: 'set_level', channel: 'surdo', deltaDB: -5 });
    const r = await op.cmd({ type: 'scene_save', name: 'Roda de sábado', description: 'Surdo mais baixo' });
    expect(r.code).toBe('OK');
    expect(r.message).toContain('Nada foi alterado');
    const file = join(t.dir, 'scenes', `${r.data.scene.id}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json).toMatchObject({
      schemaVersion: 2,
      kind: 'mixai-scene',
      id: r.data.scene.id,
      name: 'Roda de sábado',
      description: 'Surdo mais baixo',
      deviceProfile: { model: 'ui16', inputs: 12, aux: 6 },
      validationStatus: 'UNVERIFIED',
    });
    expect(Date.parse(json.createdAt)).not.toBeNaN();
    expect(Date.parse(json.updatedAt)).not.toBeNaN();
    expect(json.params['ch.8.main.level']).toEqual({ value: '-inf', status: 'unknown' }); // −∞ preservado
    expect(json.params['ch.9.main.level']).toEqual({ value: -15, status: 'unknown' });
    expect(json.params['master.level'].value).toBe(-6);
    expect(json.params['ch.1.eq.b1.gain']).toEqual({ value: 0, status: 'incompatible' }); // EQ: só laboratório
    // nomes da banda não mudaram
    expect(readFileSync(join(PROJECT_ROOT, 'test', 'fixtures', 'legacy-channels.yaml'), 'utf8')).toContain('Surdo');
  });

  it('2. persiste depois de reiniciar o servidor', async () => {
    const t1 = await startTestServer({ channels: band() });
    const op1 = await screen(t1);
    const saved = (await op1.cmd({ type: 'scene_save', name: 'Ensaio' })).data.scene;
    await t1.server.close();
    const t2 = await start({ dir: t1.dir });
    const op2 = await screen(t2);
    const list = await op2.cmd({ type: 'scene_list' });
    expect(list.data.scenes.map((s: { name: string }) => s.name)).toEqual(['Ensaio']);
    const got = await op2.cmd({ type: 'scene_get', id: saved.id });
    expect(got.data.scene).toMatchObject({ id: saved.id, name: 'Ensaio', params: saved.params });
    expect(got.data.rows.find((r: { key: string }) => r.key === 'ch.9.main.level')).toMatchObject({ group: 'PA', channel: 'Surdo', value: -10, applicable: true });
  });

  it('3. duplica e renomeia (nomes do usuário, sem repetição); excluir pede o nome e move para excluidas/', async () => {
    const t = await start();
    const op = await screen(t);
    const a = (await op.cmd({ type: 'scene_save', name: 'Pagode' })).data.scene;
    expect((await op.cmd({ type: 'scene_save', name: 'pagode' })).code).toBe('CONFLICT');
    const copy = await op.cmd({ type: 'scene_duplicate', id: a.id });
    expect(copy.data.scene.name).toBe('Pagode (cópia)');
    expect(copy.data.scene.id).not.toBe(a.id);
    const renamed = await op.cmd({ type: 'scene_update', id: copy.data.scene.id, name: 'Samba de roda', description: 'acústico' });
    expect(renamed.data.scene).toMatchObject({ name: 'Samba de roda', description: 'acústico' });
    expect((await op.cmd({ type: 'scene_update', id: copy.data.scene.id, name: 'Pagode' })).code).toBe('CONFLICT');
    expect((await op.cmd({ type: 'scene_update', id: a.id, name: '   ' })).code).toBe('INVALID');
    // os valores continuam os mesmos depois de renomear
    const get = (id: string) => op.cmd({ type: 'scene_get', id });
    expect((await get(copy.data.scene.id)).data.rows).toEqual((await get(a.id)).data.rows);
    // excluir: nome errado não exclui; nome certo move o arquivo
    expect((await op.cmd({ type: 'scene_delete', id: a.id, expectedName: 'Samba de roda' })).code).toBe('CONFLICT');
    expect((await op.cmd({ type: 'scene_delete', id: a.id, expectedName: 'Pagode' })).code).toBe('OK');
    expect(existsSync(join(t.dir, 'scenes', `${a.id}.json`))).toBe(false);
    expect(readdirSync(join(t.dir, 'scenes', 'excluidas')).some((f) => f.startsWith(a.id))).toBe(true);
    expect((await op.cmd({ type: 'scene_list' })).data.scenes.map((s: { name: string }) => s.name)).toEqual(['Samba de roda']);
  });
});

describe('cenas: exportar e importar JSON (ROG → Yoga)', () => {
  it('4 e 9. exporta no ROG, leva o arquivo e importa no Yoga: mesma cena, NADA aplicado', async () => {
    // ROG: computador de desenvolvimento, com a sua própria pasta de dados
    const rog = await start();
    const rogOp = await screen(rog);
    await rogOp.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 3 });
    await rogOp.cmd({ type: 'set_level', channel: 'voz fernando', aux: 'fones', deltaDB: 3 });
    await rogOp.force({ type: 'set_level', channel: 'tantã', db: -100 });
    const saved = (await rogOp.cmd({ type: 'scene_save', name: 'Show do bar', description: 'preparada no ROG' })).data.scene;
    const exp = await rogOp.cmd({ type: 'scene_export', id: saved.id });
    expect(exp.data.fileName).toBe('mixai-cena-show-do-bar.json');
    const pendrive = mkdtempSync(join(tmpdir(), 'mixai-pendrive-'));
    writeFileSync(join(pendrive, exp.data.fileName), exp.data.json);

    // Yoga: outro computador, outra pasta de dados, estado do laboratório diferente
    const yoga = await start();
    expect(yoga.dir).not.toBe(rog.dir);
    const yogaOp = await screen(yoga);
    const before = { surdo: v(yoga, PA(9)), fones: v(yoga, FONES(6)), tanta: v(yoga, PA(8)) };
    const imp = await yogaOp.cmd({ type: 'scene_import', json: readFileSync(join(pendrive, exp.data.fileName), 'utf8') });
    expect(imp.code).toBe('OK');
    expect(imp.message).toContain('Nada foi aplicado');
    expect(imp.data.scene.id).not.toBe(saved.id); // sempre uma cena nova no destino
    // 9: importar não aplica nada e não cria pendência
    expect({ surdo: v(yoga, PA(9)), fones: v(yoga, FONES(6)), tanta: v(yoga, PA(8)) }).toEqual(before);
    expect((await yoga.http('/api/pending', { token: await yoga.login(OPERATOR_PIN) })).json.items).toEqual([]);
    // mesmo conteúdo, inclusive −∞
    const onYoga = JSON.parse(readFileSync(join(yoga.dir, 'scenes', `${imp.data.scene.id}.json`), 'utf8'));
    const original = JSON.parse(exp.data.json);
    expect(onYoga.params).toEqual(original.params);
    expect(onYoga.params['ch.8.main.level'].value).toBe('-inf');
    expect(onYoga).toMatchObject({ name: 'Show do bar', description: 'preparada no ROG', source: { mode: 'import' } });
    // importar de novo: nome livre, nada sobrescrito
    const again = await yogaOp.cmd({ type: 'scene_import', json: exp.data.json });
    expect(again.data.scene.name).toBe('Show do bar (importada)');
    expect(again.data.warnings.join(' ')).toContain('já existia');
    expect((await yogaOp.cmd({ type: 'scene_list' })).data.scenes).toHaveLength(2);
  });

  it('5. JSON inválido, de outro tipo ou com valores fora da faixa é recusado com mensagem', async () => {
    const t = await start();
    const op = await screen(t);
    const good = JSON.parse((await op.cmd({ type: 'scene_export', id: (await op.cmd({ type: 'scene_save', name: 'Base' })).data.scene.id })).data.json);
    const cases: Array<[string, RegExp]> = [
      ['{ isto não é json', /JSON válido/],
      ['[1,2,3]', /objeto JSON/],
      [JSON.stringify({ kind: 'soundcraft-snapshot' }), /não é uma cena do MixAI/],
      [JSON.stringify({ ...good, name: '' }), /nome/],
      [JSON.stringify({ ...good, params: { ...good.params, 'ch.1.main.level': { value: 50 } } }), /máximo/],
      [JSON.stringify({ ...good, params: { ...good.params, 'ch.1.main.mute': { value: 'sim' } } }), /params/],
      [JSON.stringify({ ...good, params: { 'nao.e.chave': { value: 1 } } }), /identificador/],
      [JSON.stringify({ ...good, extra: 'campo desconhecido' }), /extra|Unrecognized|chave/i],
      [JSON.stringify({ ...good, params: { ...good.params, 'ch.1.main.level': { value: 'Infinity' } } }), /params/],
    ];
    for (const [json, msg] of cases) {
      const r = await op.cmd({ type: 'scene_import', json });
      expect(r.code, json.slice(0, 60)).toBe('INVALID');
      expect(r.message, json.slice(0, 60)).toMatch(msg);
    }
    expect((await op.cmd({ type: 'scene_list' })).data.scenes).toHaveLength(1);
  });

  it('6. versão de formato incompatível é recusada (antiga e mais nova)', async () => {
    const t = await start();
    const op = await screen(t);
    const good = JSON.parse((await op.cmd({ type: 'scene_export', id: (await op.cmd({ type: 'scene_save', name: 'Base' })).data.scene.id })).data.json);
    const newer = await op.cmd({ type: 'scene_import', json: JSON.stringify({ ...good, schemaVersion: 3 }) });
    expect(newer).toMatchObject({ code: 'INVALID', data: { reason: 'SCHEMA_VERSION' } });
    expect(newer.message).toContain('versão mais nova do MixAI');
    const older = await op.cmd({ type: 'scene_import', json: JSON.stringify({ ...good, schemaVersion: 1 }) });
    expect(older).toMatchObject({ code: 'INVALID', data: { reason: 'SCHEMA_VERSION' } });
  });

  it('7. equipamento incompatível: outro modelo é recusado; outro tamanho entra com aviso e o excedente não é aplicado', async () => {
    const t = await start();
    const op = await screen(t);
    const good = JSON.parse((await op.cmd({ type: 'scene_export', id: (await op.cmd({ type: 'scene_save', name: 'Base' })).data.scene.id })).data.json);
    const ui24 = await op.cmd({ type: 'scene_import', json: JSON.stringify({ ...good, deviceProfile: { model: 'ui24', inputs: 24, aux: 10 } }) });
    expect(ui24).toMatchObject({ code: 'INVALID', data: { reason: 'DEVICE_MISMATCH' } });
    expect(ui24.message).toContain('UI24');
    const bigger = {
      ...good,
      name: 'Mesa maior',
      deviceProfile: { model: 'ui16', inputs: 16, aux: 6 },
      params: { ...good.params, 'ch.14.main.level': { value: -3, status: 'unknown' } },
    };
    const r = await op.cmd({ type: 'scene_import', json: JSON.stringify(bigger) });
    expect(r.code).toBe('OK');
    expect(r.data.warnings.join(' ')).toMatch(/16 entradas/);
    const got = await op.cmd({ type: 'scene_get', id: r.data.scene.id });
    expect(got.data.unknownKeys).toEqual(['ch.14.main.level']);
    const cmp = await op.cmd({ type: 'scene_compare', id: r.data.scene.id });
    expect(cmp.data.rows.some((x: { key: string }) => x.key === 'ch.14.main.level')).toBe(false);
  });
});

describe('cenas: arquivo de outro equipamento colocado direto em data/scenes', () => {
  it('outro modelo nunca é consultado, comparado nem carregado; o arquivo fica intacto', async () => {
    const t = await start();
    const op = await screen(t);
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -5 });
    const base = (await op.cmd({ type: 'scene_save', name: 'Base' })).data.scene.id;
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -10 });
    const json = JSON.parse((await op.cmd({ type: 'scene_export', id: base })).data.json);
    // copiado à mão (pendrive/Explorer), sem passar pela importação
    const id = 'cena-ui24manual';
    const file = join(t.dir, 'scenes', `${id}.json`);
    const text = `${JSON.stringify({ ...json, id, name: 'Do bar (Ui24)', deviceProfile: { model: 'ui24', inputs: 24, aux: 10 } }, null, 2)}\n`;
    writeFileSync(file, text);

    const list = await op.cmd({ type: 'scene_list' });
    expect(list.data.scenes.map((x: { id: string }) => x.id)).toEqual([base]); // fora da lista de uso
    expect(list.data.invalid).toEqual([{ file: `${id}.json`, reason: 'DEVICE_MISMATCH', error: expect.stringContaining('Cena incompatível com esta mesa') }]);
    expect(list.data.invalid[0].error).toContain('UI24');
    for (const command of [
      { type: 'scene_get', id },
      { type: 'scene_compare', id },
      { type: 'scene_load', id, previewId: 'pv-qualquer' },
      { type: 'scene_duplicate', id },
      { type: 'scene_export', id },
    ]) {
      const r = await op.cmd(command);
      expect(r.ok, command.type).toBe(false);
      if (command.type !== 'scene_load') {
        expect(r.data.reason, command.type).toBe('DEVICE_MISMATCH');
        expect(r.message).toContain('não pode ser consultado, comparado nem carregado');
      }
    }
    expect(v(t, PA(9))).toBe(-10); // nada aplicado
    expect(readFileSync(file, 'utf8')).toBe(text); // preservado byte a byte

    // arquivo trocado por outro modelo DEPOIS da comparação: o pedido é recusado e nada muda
    const cmp = await op.cmd({ type: 'scene_compare', id: base });
    const baseFile = join(t.dir, 'scenes', `${base}.json`);
    const swapped = `${JSON.stringify({ ...json, deviceProfile: { model: 'ui24', inputs: 24, aux: 10 } }, null, 2)}\n`;
    writeFileSync(baseFile, swapped);
    const req = await op.cmd({ type: 'scene_load', id: base, previewId: cmp.data.previewId });
    expect(req).toMatchObject({ ok: false, data: { reason: 'DEVICE_MISMATCH' } });
    expect(v(t, PA(9))).toBe(-10);
    expect((await t.http('/api/pending', { token: await t.login(OPERATOR_PIN) })).json.items).toEqual([]);
    expect(readFileSync(baseFile, 'utf8')).toBe(swapped);
  });

  it('trocado entre o pedido e a aprovação: a aprovação não aplica nada', async () => {
    const t = await start();
    const op = await screen(t);
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -5 });
    const id = (await op.cmd({ type: 'scene_save', name: 'Show' })).data.scene.id;
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -10 });
    const { req } = await compareAndRequest(op, id);
    expect(req.code).toBe('NEEDS_CONFIRMATION');
    const file = join(t.dir, 'scenes', `${id}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...json, deviceProfile: { model: 'ui12', inputs: 8, aux: 2 } }));
    const ap = await op.approve(req.pendingId);
    expect(ap.ok).toBe(false);
    expect(ap.message).toContain('incompatível');
    expect(v(t, PA(9))).toBe(-10);
  });

  it('mesmo modelo com outro tamanho, colocado direto no disco: continua usável com aviso (regra mantida)', async () => {
    const t = await start();
    const op = await screen(t);
    const base = (await op.cmd({ type: 'scene_save', name: 'Base' })).data.scene.id;
    const json = JSON.parse((await op.cmd({ type: 'scene_export', id: base })).data.json);
    const id = 'cena-maior16in';
    writeFileSync(
      join(t.dir, 'scenes', `${id}.json`),
      JSON.stringify({
        ...json,
        id,
        name: 'Maior',
        deviceProfile: { model: 'ui16', inputs: 16, aux: 6 },
        params: { ...json.params, 'ch.9.main.level': { value: -4, status: 'unknown' }, 'ch.14.main.level': { value: -2, status: 'unknown' } },
      }),
    );
    const got = await op.cmd({ type: 'scene_get', id });
    expect(got.ok).toBe(true);
    expect(got.data.warnings.join(' ')).toMatch(/16 entradas/);
    expect(got.data.unknownKeys).toEqual(['ch.14.main.level']);
    const { req } = await compareAndRequest(op, id);
    await op.approve(req.pendingId);
    expect(v(t, PA(9))).toBe(-4); // o que existe aqui é aplicado; ch.14 não existe e não é aplicado
  });
});

describe('cenas: comparação', () => {
  it('8. calcula só o que difere, por destino, com a diferença em dB, mute e o que ainda não é aplicável', async () => {
    const t = await start();
    const op = await screen(t);
    // estado da cena: Surdo PA −12, Cavaco PA −12, Voz Fernando FONES −17, Pandeiro mutado no PA, master −8
    await op.cmd({ type: 'set_level', channel: 'surdo', deltaDB: -2 });
    await op.cmd({ type: 'set_level', channel: 'cavaco', deltaDB: -2 });
    await op.cmd({ type: 'set_level', channel: 'voz fernando', aux: 'fones', deltaDB: 3 });
    await op.cmd({ type: 'set_mute', channels: ['pandeiro'], muted: true });
    await op.force({ type: 'set_master', db: -8 });
    const id = (await op.cmd({ type: 'scene_save', name: 'Alvo' })).data.scene.id;
    // estado atual diferente: Surdo −15, Cavaco −10, Voz Fernando −20, Pandeiro aberto, master −6
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -15 });
    await op.cmd({ type: 'set_level', channel: 'cavaco', db: -10 });
    await op.cmd({ type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -20 });
    await op.cmd({ type: 'set_mute', channels: ['pandeiro'], muted: false });
    await op.force({ type: 'set_master', db: -6 });
    const cmp = await op.cmd({ type: 'scene_compare', id });
    const rows = cmp.data.rows.map((r: Record<string, unknown>) => [r.channel, r.destination, r.kind, r.current, r.target, r.deltaDB, r.applicable]);
    expect(rows).toEqual([
      ['Cavaco', 'PA', 'level', -10, -12, -2, true],
      ['Pandeiro', 'PA', 'mute', false, true, null, true],
      ['Surdo', 'PA', 'level', -15, -12, 3, true],
      ['Voz Fernando', 'FONES', 'level', -20, -17, 3, true],
      ['MASTER', 'MASTER', 'level', -6, -8, -2, true],
    ]);
    expect(cmp.data.totals).toEqual({ changes: 5, applicable: 5, notApplicable: 0, byGroup: { PA: 3, FONES: 1, MASTER: 1, OUTROS: 0 } });
    expect(cmp.message).toContain('5 alteração(ões)');
    // EQ diferente: aparece em OUTROS como ainda não aplicável (sem caminho de escrita novo)
    const json = JSON.parse((await op.cmd({ type: 'scene_export', id })).data.json);
    json.params['ch.1.eq.b2.gain'] = { value: -4, status: 'incompatible' };
    json.params['ch.11.aux.3.level'] = { value: -5, status: 'unknown' }; // AUX fora do channels.yaml
    const withEq = (await op.cmd({ type: 'scene_import', json: JSON.stringify({ ...json, name: 'Com EQ' }) })).data.scene.id;
    const cmp2 = await op.cmd({ type: 'scene_compare', id: withEq });
    const other = cmp2.data.rows.filter((r: { group: string }) => r.group === 'OUTROS');
    expect(other.map((r: Record<string, unknown>) => [r.key, r.applicable, r.reason])).toEqual([
      ['ch.1.eq.b2.gain', false, 'EQ/HPF: guardado na cena, ainda não aplicável'],
      ['ch.11.aux.3.level', false, 'AUX fora do channels.yaml'],
    ]);
    expect(cmp2.data.totals).toMatchObject({ changes: 7, applicable: 5, notApplicable: 2 });
    // comparar nunca altera nada
    expect(v(t, PA(9))).toBe(-15);
  });

  it('cena igual ao estado atual: nada a aplicar', async () => {
    const t = await start();
    const op = await screen(t);
    const id = (await op.cmd({ type: 'scene_save', name: 'Agora' })).data.scene.id;
    const cmp = await op.cmd({ type: 'scene_compare', id });
    expect(cmp.data.totals.changes).toBe(0);
    const req = await op.cmd({ type: 'scene_load', id, previewId: cmp.data.previewId });
    expect(req).toMatchObject({ ok: true, code: 'OK' });
    expect(req.message).toContain('já está aplicada');
  });
});

describe('cenas: carregamento com aprovação humana (mecanismo da E2)', () => {
  async function prepared() {
    const t = await start();
    const op = await screen(t);
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -12 });
    await op.cmd({ type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -17 });
    await op.cmd({ type: 'set_mute', channels: ['pandeiro'], muted: true });
    const id = (await op.cmd({ type: 'scene_save', name: 'Show' })).data.scene.id;
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -15 });
    await op.cmd({ type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -20 });
    await op.cmd({ type: 'set_mute', channels: ['pandeiro'], muted: false });
    return { t, op, id };
  }

  it('10. só carrega depois da aprovação; tudo numa operação, com perfil e sessão no histórico', async () => {
    const { t, op, id } = await prepared();
    // sem prévia não dá
    expect((await op.cmd({ type: 'scene_load', id, previewId: 'pv-inventado' })).code).toBe('CONFIRMATION_STALE');
    const { req } = await compareAndRequest(op, id);
    expect(req).toMatchObject({ ok: false, code: 'NEEDS_CONFIRMATION' });
    expect(req.message).toContain('Aguardando a aprovação de um operador');
    const card = (await op.c.next((m) => m.type === 'pending')).card;
    expect(card).toMatchObject({ title: 'carregar cena do MixAI (laboratório)', command: { type: 'scene_load', id } });
    expect(card.summary).toContain('3 parâmetro(s) mudam');
    expect([v(t, PA(9)), v(t, FONES(6)), v(t, paramKey.mute(7, MASTER))]).toEqual([-15, -20, false]); // nada mudou
    const ok = await op.approve(card.pendingId);
    expect(ok).toMatchObject({ ok: true, code: 'OK' });
    expect([v(t, PA(9)), v(t, FONES(6)), v(t, paramKey.mute(7, MASTER))]).toEqual([-12, -17, true]);
    const hist = (await op.cmd({ type: 'history', limit: 5 })).data.entries as Array<{ action: string; details: { by?: string; changed?: number } }>;
    const loads = hist.filter((e) => e.action === 'scene_load');
    expect(loads).toHaveLength(1);
    expect(loads[0]!.details.changed).toBe(3);
    expect(loads[0]!.details.by).toMatch(/^operador · sessão [0-9a-f]{6}; aprovado por operador · sessão [0-9a-f]{6}$/);
    // a mesma prévia não serve duas vezes
    expect((await op.cmd({ type: 'scene_load', id, previewId: (await op.cmd({ type: 'scene_compare', id })).data.previewId })).code).toBe('OK');
  });

  it('11. estado mudou entre a prévia e o pedido: recusa e pede nova comparação', async () => {
    const { t, op, id } = await prepared();
    const cmp = await op.cmd({ type: 'scene_compare', id });
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -14 }); // alguém mexeu
    const req = await op.cmd({ type: 'scene_load', id, previewId: cmp.data.previewId });
    expect(req.code).toBe('STATE_CHANGED');
    expect(req.message).toContain('compare a cena de novo');
    expect(v(t, PA(9))).toBe(-14);
  });

  it('11. estado mudou entre o pedido e a aprovação: pendência invalidada; a mudança posterior não é sobrescrita', async () => {
    const { t, op, id } = await prepared();
    const { req } = await compareAndRequest(op, id);
    expect(req.code).toBe('NEEDS_CONFIRMATION');
    await op.cmd({ type: 'set_level', channel: 'voz fernando', aux: 'fones', db: -18 }); // mudança posterior
    const resolved = await op.c.next((m) => m.type === 'pending_resolved' && m.pendingId === req.pendingId, 4000);
    expect(resolved.status).toBe('invalidated'); // o cartão some sozinho
    const late = await op.approve(req.pendingId);
    expect(late.ok).toBe(false);
    expect(['CONFIRMATION_STALE']).toContain(late.code);
    expect([v(t, PA(9)), v(t, FONES(6))]).toEqual([-15, -18]); // nada da cena velha foi aplicado
  });

  it('a pendência também cai se a cena for excluída antes da aprovação', async () => {
    const { t, op, id } = await prepared();
    const { req } = await compareAndRequest(op, id);
    await op.cmd({ type: 'scene_delete', id, expectedName: 'Show' });
    const r = await op.approve(req.pendingId);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(v(t, PA(9))).toBe(-15);
  });

  it('14. desfazer o carregamento como UMA operação, respeitando as revisões', async () => {
    const { t, op, id } = await prepared();
    const { req } = await compareAndRequest(op, id);
    await op.approve(req.pendingId);
    expect([v(t, PA(9)), v(t, FONES(6)), v(t, paramKey.mute(7, MASTER))]).toEqual([-12, -17, true]);
    const undo = await op.cmd({ type: 'undo' });
    expect(undo.ok).toBe(true);
    expect([v(t, PA(9)), v(t, FONES(6)), v(t, paramKey.mute(7, MASTER))]).toEqual([-15, -20, false]); // tudo de uma vez

    // com uma mudança posterior num dos parâmetros, o desfazer não a sobrescreve
    const again = await compareAndRequest(op, id);
    await op.approve(again.req.pendingId);
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -11 }); // depois da cena
    await op.cmd({ type: 'undo' }); // desfaz o −11 (o mais recente)
    expect(v(t, PA(9))).toBe(-12);
    await op.cmd({ type: 'set_level', channel: 'surdo', db: -13 });
    const hist = (await op.cmd({ type: 'history', limit: 3 })).data.entries;
    expect(hist.at(-1).action).toBe('set_level');
  });

  it('falha no meio da aplicação: resultado PARCIAL/INCERTO, nunca sucesso completo', async () => {
    const { t, op, id } = await prepared();
    const { req } = await compareAndRequest(op, id);
    const orig = t.mixer.write.bind(t.mixer);
    let n = 0;
    t.mixer.write = async (k, val) => {
      if (++n === 2) throw new Error('falha simulada no meio da cena');
      return orig(k, val);
    };
    const r = await op.approve(req.pendingId);
    t.mixer.write = orig;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.message).toMatch(/PARCIAL/);
    expect(r.message).toMatch(/INCERTO/);
    const hist = (await op.cmd({ type: 'history', limit: 3 })).data.entries as Array<{ action: string; ok: boolean }>;
    expect(hist.filter((e) => e.action === 'scene_load').at(-1)!.ok).toBe(false);
  });

  it('15. tetos de segurança valem: volume acima do teto aparece limitado na prévia e é aplicado limitado', async () => {
    const { t, op, id } = await prepared();
    const json = JSON.parse((await op.cmd({ type: 'scene_export', id })).data.json);
    json.params['ch.9.main.level'] = { value: 8, status: 'unknown' }; // acima do teto (0 dB)
    const loud = (await op.cmd({ type: 'scene_import', json: JSON.stringify({ ...json, name: 'Alta demais' }) })).data.scene.id;
    const cmp = await op.cmd({ type: 'scene_compare', id: loud });
    expect(cmp.data.rows.find((r: { key: string }) => r.key === 'ch.9.main.level')).toMatchObject({ target: 8, clampedTo: 0, deltaDB: 15 });
    const req = await op.cmd({ type: 'scene_load', id: loud, previewId: cmp.data.previewId });
    await op.approve(req.pendingId);
    expect(v(t, PA(9))).toBe(0);
  });
});

describe('cenas: permissões (backend)', () => {
  it('12. músico não acessa cenas em nenhum modo — inclusive pa_without_master — nem aprova', async () => {
    for (const access of ['fones_only', 'pa_without_master']) {
      const t = await start({ server: { musicianAccess: access } });
      const op = await screen(t);
      const id = (await op.cmd({ type: 'scene_save', name: 'Show' })).data.scene.id;
      const m = await screen(t, MUSICIAN_PIN);
      for (const command of [
        { type: 'scene_list' },
        { type: 'scene_get', id },
        { type: 'scene_save', name: 'Minha' },
        { type: 'scene_compare', id },
        { type: 'scene_load', id, previewId: 'x' },
        { type: 'scene_export', id },
        { type: 'scene_import', json: '{}' },
        { type: 'scene_delete', id, expectedName: 'Show' },
      ]) {
        const r = await m.cmd(command);
        expect(r.code, `${access} ${command.type}`).toBe('FORBIDDEN');
        expect(r.message).toContain('só do operador');
      }
      const { req } = await compareAndRequest(op, id);
      expect((await m.approve(req.pendingId ?? 'x')).code).toBe('FORBIDDEN');
    }
  });

  it('assistente (MCP) não gerencia, carrega nem aprova cenas', async () => {
    const t = await start();
    const op = await screen(t);
    await op.cmd({ type: 'set_level', channel: 'surdo', deltaDB: -3 });
    const id = (await op.cmd({ type: 'scene_save', name: 'Show' })).data.scene.id;
    await op.cmd({ type: 'set_level', channel: 'surdo', deltaDB: 3 });
    const agent = readFileSync(`${t.dir}/agent-lab.token`, 'utf8');
    let n = 0;
    const call = (command: Record<string, unknown>) => t.http('/api/command', { token: agent, body: { requestId: `ag-${++n}`, command } });
    for (const command of [{ type: 'scene_list' }, { type: 'scene_compare', id }, { type: 'scene_load', id, previewId: 'x' }, { type: 'scene_import', json: '{}' }]) {
      const r = await call(command);
      expect(r.json.result.code).toBe('FORBIDDEN');
      expect(r.json.result.message).toContain('assistente não');
    }
    const { req } = await compareAndRequest(op, id);
    const ap = await t.http(`/api/pending/${req.pendingId}/approve`, { token: agent, body: { requestId: 'ag-ap' } });
    expect(ap.json.result.code).toBe('FORBIDDEN');
    expect(v(t, PA(9))).toBe(-10);
  });

  it('assistente de texto da tela não carrega cena (pede de snapshot nativo não vira cena)', async () => {
    const t = await start();
    const c = await wsClient(t.base, await t.login(OPERATOR_PIN));
    clients.push(c);
    await c.next((m) => m.type === 'snapshot');
    c.send({ type: 'assistant', requestId: 'q1', text: 'carrega a cena show' });
    const r = (await c.next((m) => m.type === 'assistant_reply')).reply;
    expect(r.kind).not.toBe('proposals');
  });
});

describe('cenas: nunca na mesa REAL', () => {
  it('13. fora do laboratório: comparar, salvar do estado e carregar são recusados e nada é escrito', async () => {
    const mixer = new MockMixer();
    Object.defineProperty(mixer, 'mode', { value: 'real' });
    await mixer.connect();
    const writes: string[] = [];
    const orig = mixer.write.bind(mixer);
    mixer.write = async (k, val) => {
      writes.push(k);
      return orig(k, val);
    };
    const cfg = parseConfig({});
    const log = new ActionLog(null);
    const controller = new MixController(mixer, cfg.safety, new ChannelMap(band(), mixer.capabilities()), log);
    const dir = mkdtempSync(join(tmpdir(), 'mixai-real-'));
    const store = new SceneStore(join(dir, 'scenes'), controller.registry, deviceProfileOf(mixer.capabilities()));
    store.create({ name: 'Do laboratório', values: new Map([[paramKey.level(9, MASTER), -3]]) });
    const scenes = new ScenesService(controller, store, log, { mode: 'real', policy: () => DEFAULT_POLICY });
    const op = { id: 'op1', role: 'operator' as const, label: 'operador' };
    const id = store.list().scenes[0]!.id;
    expect(scenes.labOnly).toBe(false);
    for (const cmd of [{ type: 'scene_compare', id }, { type: 'scene_load', id, previewId: 'x' }, { type: 'scene_save', name: 'Real' }] as const) {
      const r = await scenes.handle(op, cmd as never);
      expect(r.code).toBe('MODE_MISMATCH');
      expect(r.message).toContain('Nenhuma cena é enviada à mesa real');
    }
    // nem chamando o controlador direto
    const direct = await controller.loadScene({ sceneId: id, sceneName: 'x', hash: 'h', targets: [{ key: paramKey.level(9, MASTER), label: 'Surdo', to: -3 }], confirmationId: 'qualquer' });
    expect(direct.code).toBe('MODE_MISMATCH');
    expect(writes).toEqual([]);
    // listar e exportar continuam (só leitura de arquivos)
    expect((await scenes.handle(op, { type: 'scene_list' })).data!.canLoad).toBe(false);
  });

  it('o hello informa que as cenas só carregam no laboratório', async () => {
    const t = await start();
    const c = await wsClient(t.base, await t.login(OPERATOR_PIN));
    clients.push(c);
    expect((await c.next((m) => m.type === 'hello')).scenes).toEqual({ available: true, canLoad: true });
  });
});

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { PROJECT_ROOT } from '../../src/core/config.js';
import { bandChannels, enter, launch, MUSICIAN_PIN, OPERATOR_PIN, PHONE, startLab, YOGA } from './harness.js';

/** Gera as capturas da E3 em docs/lab/img (npm run screenshots, depois de npm run build:web). */
it('capturas da interface (Yoga e celular)', async () => {
  const out = join(PROJECT_ROOT, 'docs', 'lab', 'img');
  mkdirSync(out, { recursive: true });
  const l = await startLab({ channels: bandChannels(), safety: { maxStepDB: 40 } }); // só para montar a cena sem cartões
  const browser = await launch();
  try {
    // Uma mix plausível de roda de samba (laboratório).
    const op = await l.login(OPERATOR_PIN);
    const mix: Array<[number, number]> = [[1, -6], [2, -9], [3, -4], [4, -5], [5, -7], [6, -3], [7, -12], [8, -14], [9, -8], [10, -16]];
    for (const [ch, db] of mix) await l.command(op, { type: 'set_level', channel: ch, db });
    await l.command(op, { type: 'set_mute', channels: [11], muted: true });
    for (const [ch, db] of [[3, -12], [4, -10], [5, -14], [6, -11], [1, -18], [9, -22]] as const) {
      await l.command(op, { type: 'set_level', channel: ch, aux: 1, db });
    }

    const yoga = await enter(browser, l.base, OPERATOR_PIN, YOGA);
    await yoga.page.waitForTimeout(700);
    await yoga.page.screenshot({ path: join(out, 'e3-yoga-mesa-pa.png') });

    const token = readFileSync(`${l.dir}/agent-lab.token`, 'utf8');
    await l.http('/api/command', { token, body: { requestId: 'shot-1', targetMode: 'lab', command: { type: 'set_master', deltaDB: -3 } } });
    await yoga.page.locator('.card').waitFor();
    await yoga.page.waitForTimeout(300);
    await yoga.page.screenshot({ path: join(out, 'e3-yoga-cartao-aprovacao.png') });

    await yoga.page.getByRole('tab', { name: 'FONES' }).click();
    await yoga.page.waitForTimeout(300);
    await yoga.page.screenshot({ path: join(out, 'e3-yoga-fones.png') });

    const login = await browser.newContext({ ...PHONE, baseURL: l.base });
    const lp = await login.newPage();
    await lp.goto('/');
    await lp.getByRole('button', { name: 'Entrar' }).waitFor();
    await lp.screenshot({ path: join(out, 'e3-celular-pin.png') });

    const mus = await enter(browser, l.base, MUSICIAN_PIN, PHONE);
    await mus.page.waitForTimeout(400);
    await mus.page.screenshot({ path: join(out, 'e3-celular-fones-musico.png') });

    const opPhone = await enter(browser, l.base, OPERATOR_PIN, PHONE);
    await opPhone.page.waitForTimeout(600);
    await opPhone.page.screenshot({ path: join(out, 'e3-celular-mesa-operador.png') });
  } finally {
    await browser.close();
    await l.server.close();
  }
}, 90_000);

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnerLock, OwnerLockError, ownerLockFile } from '../src/core/owner-lock.js';
import { PROJECT_ROOT } from '../src/core/config.js';

const WORKER = join(PROJECT_ROOT, 'test', 'support', 'lock-worker.ts');

/** Roda N processos Node separados que tentam a trava no MESMO instante. */
async function race(target: string, n: number, opts: { lockDir: string; holdMs?: number; installs?: string[] }) {
  const startAt = Date.now() + 1500; // tempo para todos os processos subirem
  const runs = Array.from({ length: n }, (_, i) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', WORKER, target, String(opts.holdMs ?? 1500), String(startAt), opts.installs?.[i] ?? `inst-${i}`],
        { cwd: PROJECT_ROOT, env: { ...process.env, MIXAI_LOCK_DIR: opts.lockDir } },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', () => resolve(out.trim()));
    }),
  );
  return Promise.all(runs);
}

/** pid de um processo que já terminou (dono "morto"). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(String(r.stdout));
}

describe('trava de dono entre processos e instalações', () => {
  it('modo REAL: a trava não depende da pasta da instalação (compartilhada no computador)', () => {
    const shared = mkdtempSync(join(tmpdir(), 'mixai-locks-'));
    const a = ownerLockFile('real', '/instalacao-A/data/lab-state.json', shared);
    const b = ownerLockFile('real', 'C:\\outra\\copia\\data\\lab-state.json', shared);
    expect(a).toBe(b);
    expect(a!.startsWith(shared)).toBe(true);
    // o laboratório continua com uma trava por arquivo
    expect(ownerLockFile('lab', '/a/lab.json', shared)).not.toBe(ownerLockFile('lab', '/b/lab.json', shared));
  });

  it('duas INSTALAÇÕES (processos separados) para a mesma mesa: só uma controla', async () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mixai-locks-'));
    const out = await race('real', 2, { lockDir, installs: ['C:\\Desenvolvimento\\mixai', 'C:\\Users\\x\\mixai-copia'] });
    expect(out.filter((o) => o === 'ACQUIRED')).toHaveLength(1);
    expect(out.filter((o) => o === 'REFUSED')).toHaveLength(1);
  }, 30_000);

  it('vários processos ao mesmo tempo, sem trava prévia: exatamente um ganha', async () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mixai-locks-'));
    const out = await race(join(lockDir, 'disputa.lock'), 6, { lockDir });
    expect(out.filter((o) => o === 'ACQUIRED'), out.join(',')).toHaveLength(1);
    expect(out.filter((o) => o === 'REFUSED')).toHaveLength(5);
  }, 30_000);

  it('trava ABANDONADA recuperada por vários processos ao mesmo tempo: exatamente um ganha', async () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mixai-locks-'));
    const file = ownerLockFile('real', 'x', lockDir)!;
    writeFileSync(file, JSON.stringify({ pid: deadPid(), role: 'servidor', since: 'ontem', nonce: 'velha' }));
    const out = await race('real', 6, { lockDir });
    expect(out.filter((o) => o === 'ACQUIRED'), out.join(',')).toHaveLength(1);
    expect(out.filter((o) => o === 'REFUSED')).toHaveLength(5);
    expect(existsSync(file)).toBe(false); // o ganhador liberou ao sair
  }, 30_000);

  it('trava abandonada é reaproveitada; a mensagem de recusa identifica equipamento e instalação', () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mixai-locks-'));
    const file = ownerLockFile('real', 'x', lockDir)!;
    writeFileSync(file, JSON.stringify({ pid: deadPid(), role: 'servidor', since: 'ontem', nonce: 'velha' }));
    const lock = new OwnerLock(file, 'servidor', { install: '/inst/A', equipment: 'mesa ui16 em 10.10.1.1' }).acquire();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid, install: '/inst/A', equipment: 'mesa ui16 em 10.10.1.1' });
    try {
      new OwnerLock(file, 'console').acquire();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OwnerLockError);
    }
    lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('recusa quando o dono está vivo em outro processo (mensagem com equipamento e instalação)', async () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mixai-locks-'));
    const file = ownerLockFile('real', 'x', lockDir)!;
    const holder = spawn(process.execPath, ['--import', 'tsx', WORKER, 'real', '4000', String(Date.now()), '/inst/A'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MIXAI_LOCK_DIR: lockDir },
    });
    await new Promise<void>((resolve) => holder.stdout.on('data', (d) => String(d).includes('ACQUIRED') && resolve()));
    try {
      expect(() => new OwnerLock(file, 'servidor').acquire()).toThrow(/mesa ui16 em 10\.10\.1\.1.*|instalação \/inst\/A/);
    } finally {
      holder.kill();
    }
  }, 30_000);
});

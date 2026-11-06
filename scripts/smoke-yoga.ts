import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Não repassa seleção de equipamento, dados, rede ou credenciais da sessão do operador. */
export function smokeEnvironment(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(MIXAI_|ANTHROPIC_|OPENAI_|CADDY_|VITE_|NG_)/i.test(key)));
  return { ...clean, MIXAI_MODE: 'lab', MIXAI_SMOKE_DIR: dir, NG_CLI_ANALYTICS: 'false', CI: 'true' };
}
export function smokeOptions(args: string[]) {
  if (args.some((a) => a !== '--built') || args.length > 1) throw new Error('Uso: npm run smoke:yoga [-- --built]. Nenhuma opção REAL/rede é aceita.');
  return { built: args.includes('--built') };
}

export async function runSmoke(args = process.argv.slice(2)) {
  const options = smokeOptions(args);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js >=22 necessário.');
  const dir = mkdtempSync(join(tmpdir(), 'mixai-yoga-'));
  const env = smokeEnvironment(process.env, dir);
  let interrupted = false;
  let child: ReturnType<typeof spawn> | undefined;
  let force: NodeJS.Timeout | undefined;
  const stop = () => {
    interrupted = true;
    child?.kill('SIGINT');
    force ??= setTimeout(() => child?.kill('SIGKILL'), 5000);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const run = (name: string, argv: string[], cwd = ROOT) => new Promise<void>((resolveStep, reject) => {
    if (interrupted) { reject(new Error('Ensaio interrompido.')); return; }
    console.log(`\n[Yoga] ${name}`);
    child = spawn(process.execPath, argv, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => { child = undefined; code === 0 && !interrupted ? resolveStep() : reject(new Error(`${name}: falhou/interrompido (código ${code ?? 'sinal'}).`)); });
  });
  try {
    console.log(`MixAI Yoga — LAB isolado, loopback, sem Soundcraft. Node ${process.versions.node}; ${process.platform}.`);
    // Só verifica o navegador. Nenhuma instalação/download é executada pelo smoke.
    try {
      const browser = await chromium.launch({ env });
      await browser.close();
    } catch {
      throw new Error('Chromium indisponível. Instale manualmente: npx playwright install chromium. Linux pode exigir dependências do sistema. Nada foi baixado pelo smoke.');
    }
    if (!options.built) {
      await run('Contratos TypeScript', [join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json']);
      await run('Contratos de testes', [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']);
      await run('Build servidor', [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
      await run('Build interface LAB', [join(ROOT, 'web/node_modules/@angular/cli/bin/ng.js'), 'build', '--configuration', 'production'], join(ROOT, 'web'));
    }
    if (!existsSync(join(ROOT, 'dist/web/browser/index.html')) || !existsSync(join(ROOT, 'dist/serve.js'))) {
      throw new Error('Build ausente. Execute npm run smoke:yoga sem --built.');
    }
    await run('Ensaio integrado e comparação offline', [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.yoga.config.ts']);
    console.log('\n[Yoga] APROVADO: LAB/HTTP/WS, perfis, PA/FONES, EQ, cenas/undo/persistência, técnico, E8A, recusas e voz OFF.');
    console.log('[Yoga] Pendências manuais: Yoga físico/touch, celulares/rede, HTTPS opcional e F0 físico somente leitura.');
  } finally {
    if (force) clearTimeout(force);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  runSmoke().catch((err) => { console.error(`[Yoga] ${err instanceof Error ? err.message : 'Falha no ensaio.'}`); process.exitCode = 1; });
}

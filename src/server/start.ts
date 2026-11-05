import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../core/app.js';
import { PROJECT_ROOT, serverPort, type LoadedConfig } from '../core/config.js';
import { equipmentLabel, OwnerLock, ownerLockFile } from '../core/owner-lock.js';
import { Auth } from './auth.js';
import { ServerCore } from './core.js';
import { buildHttp } from './http.js';
import { listenHosts } from './listen.js';
import { SimulatedMeters } from './meters.js';

/** Arquivo com o token do assistente (pasta de dados local, fora do Git; recriado a cada início). */
export const agentTokenFile = (dataDir: string, mode: string) => join(dataDir, `agent-${mode}.token`);

export interface RunningServer {
  core: ServerCore;
  app: App;
  https: FastifyInstance[];
  urls: string[];
  port: number;
  close(): Promise<void>;
}

/**
 * Sobe o servidor único: pega a trava de dono, monta a mesa (o modo é decidido aqui, UMA vez),
 * conecta, grava o token do assistente e escuta em 127.0.0.1 (e no Wi-Fi, se configurado).
 */
export async function startServer(
  loaded: LoadedConfig,
  opts: { port?: number; app?: App; log?: (msg: string) => void; clock?: () => number; webRoot?: string } = {},
): Promise<RunningServer> {
  const { config } = loaded;
  const mode = config.mixer.mode;
  const dataDir = loaded.dataDir ?? join(process.cwd(), 'data');
  const hosts = listenHosts(config); // valida a rede ANTES de tocar na mesa
  const port = opts.port ?? serverPort(config);

  const lockFile = ownerLockFile(mode, loaded.labFile);
  const equipment = mode === 'real' ? equipmentLabel(config.mixer) : `laboratório ${loaded.labFile}`;
  const lock = lockFile ? new OwnerLock(lockFile, 'servidor', { install: PROJECT_ROOT, equipment }).acquire() : undefined;
  let app: App | undefined;
  const https: FastifyInstance[] = [];
  const tokenFile = agentTokenFile(dataDir, mode);
  try {
    app = opts.app ?? (await createApp(loaded));
    const agentToken = randomBytes(32).toString('base64url');
    const auth = new Auth({
      operatorPinHash: loaded.secrets?.operatorPinHash,
      musicianPinHash: loaded.secrets?.musicianPinHash,
      agentToken,
      sessionTtlMs: config.server.sessionHours * 3_600_000,
      clock: opts.clock,
    });
    const names = app.controller.names;
    const meters = mode === 'real' ? undefined : new SimulatedMeters(app.mixer, () => names.inputs.configured());
    const core = new ServerCore(app.controller, app.mixer, mode, auth, app.log, {
      musicianAux: config.server.musicianAux,
      clock: opts.clock,
      meters,
    });

    try {
      await app.mixer.connect();
    } catch (err) {
      opts.log?.(`sem conexão com a mesa por enquanto: ${(err as Error).message}`);
    }

    let boundPort = port;
    for (const host of hosts) {
      const http = await buildHttp(core, { webRoot: opts.webRoot ?? join(PROJECT_ROOT, 'dist', 'web', 'browser') });
      https.push(http);
      await http.listen({ host, port: boundPort });
      const addr = http.server.address();
      if (addr && typeof addr === 'object') boundPort = addr.port; // porta 0 nos testes
    }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tokenFile, agentToken, { mode: 0o600 });
    core.start();
    const urls = hosts.map((h) => `http://${h}:${boundPort}`);
    const appRef = app;
    let closed = false;
    return {
      core,
      app: appRef,
      https,
      urls,
      port: boundPort,
      async close() {
        if (closed) return;
        closed = true;
        core.stop();
        for (const h of https) await h.close().catch(() => undefined);
        await appRef.mixer.disconnect().catch(() => undefined);
        rmSync(tokenFile, { force: true });
        lock?.release();
      },
    };
  } catch (err) {
    for (const h of https) await h.close().catch(() => undefined);
    await app?.mixer.disconnect().catch(() => undefined);
    lock?.release();
    throw err;
  }
}

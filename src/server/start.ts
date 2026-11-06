import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceProfileOf } from '../core/scene.js';
import { SceneStore } from '../core/scene-store.js';
import { ScenesService } from './scenes.js';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../core/app.js';
import { PROJECT_ROOT, serverPort, type LoadedConfig } from '../core/config.js';
import { equipmentLabel, OwnerLock, ownerLockFile } from '../core/owner-lock.js';
import { Auth } from './auth.js';
import { ServerCore } from './core.js';
import { buildHttp } from './http.js';
import { listenHosts } from './listen.js';
import { httpsLabOptions } from './https-lab.js';
import { SimulatedMeters } from './meters.js';
import { ClaudeClient } from '../ai/claude.js';
import { UsageTracker } from '../ai/usage.js';
import { AssistantService } from '../assistant/service.js';

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
  opts: { port?: number; app?: App; log?: (msg: string) => void; clock?: () => number; webRoot?: string; aiFetch?: typeof fetch } = {},
): Promise<RunningServer> {
  const { config } = loaded;
  const mode = config.mixer.mode;
  const dataDir = loaded.dataDir ?? join(process.cwd(), 'data');
  const proxy = httpsLabOptions(config); // valida antes de criar/conectar qualquer mixer
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
      musicianAccess: config.server.musicianAccess,
      musicianPaStepDB: config.server.musicianPaStepDB,
      clock: opts.clock,
      meters,
    });

    // Assistente (E4): parser local sempre; Claude só com ai.enabled e chave (só no servidor).
    const ai = new ClaudeClient(
      config.ai,
      loaded.secrets?.anthropicApiKey,
      new UsageTracker(join(dataDir, 'ai-usage.json'), opts.clock),
      opts.aiFetch ?? fetch,
      opts.clock,
    );
    // Cenas do MixAI (E5): data/scenes/ (fora do Git). Comparar/carregar só no LABORATÓRIO.
    core.scenes = new ScenesService(
      app.controller,
      new SceneStore(join(dataDir, 'scenes'), app.controller.registry, deviceProfileOf(app.mixer.capabilities()), opts.clock),
      app.log,
      { mode, policy: () => core.policy, clock: opts.clock },
    );
    core.assistant = new AssistantService(core, {
      steps: config.assistant,
      ttlMs: config.assistant.proposalTtlSec * 1000,
      channels: loaded.channels.channels,
      ai,
      log: app.log,
      clock: opts.clock,
    });
    if (config.ai.enabled && !loaded.secrets?.anthropicApiKey) opts.log?.('ai.enabled = true, mas sem chave (ANTHROPIC_API_KEY ou anthropicApiKey em config/secrets.yaml): só o parser local.');

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
    if (proxy) {
      if (proxy.port === boundPort) throw new Error('HTTPS LAB: porta do proxy deve diferir da porta HTTP local.');
      const ingress = await buildHttp(core, { labProxyOrigin: proxy.origin, webRoot: opts.webRoot ?? join(PROJECT_ROOT, 'dist', 'web', 'browser') });
      https.push(ingress);
      await ingress.listen({ host: '127.0.0.1', port: proxy.port });
      opts.log?.(`HTTPS LAB: entrada do proxy em 127.0.0.1:${proxy.port}; origem HTTPS privada esperada: ${proxy.origin}`);
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

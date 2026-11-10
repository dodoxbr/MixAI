import { AutoConfigAdvisor } from '../autoconfig/suggestion-source.js';
import { AutoConfigService } from '../autoconfig/service.js';
import type { AutoConfigSimulator } from '../autoconfig/contracts.js';
import { MusicianAccess } from './musician-access.js';
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
import { PrivatePtt } from '../speech/private-ptt.js';
import type { FileSpeechRecognizer } from '../speech/whisper-file.js';
import { ReferenceStore } from '../reference/store.js';
import { referencePortsOf } from '../reference/adapters.js';
import { ReferenceService } from '../reference/service.js';
import type { ReferencePorts } from '../reference/contracts.js';
import { SimulatedMeters } from './meters.js';
import { ClaudeClient } from '../ai/claude.js';
import { UsageTracker } from '../ai/usage.js';
import { AssistantService } from '../assistant/service.js';
import { openLocalKnowledge, type LocalKnowledge } from '../knowledge/local/index.js';

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
  opts: { port?: number; app?: App; log?: (msg: string) => void; clock?: () => number; webRoot?: string; aiFetch?: typeof fetch; pttRecognizer?: FileSpeechRecognizer; autoConfigSimulator?: AutoConfigSimulator; autoConfigPlannerFetch?: typeof fetch; autoConfigPlannerGeminiFetch?: typeof fetch; referencePorts?: ReferencePorts; knowledge?: LocalKnowledge } = {},
): Promise<RunningServer> {
  const { config } = loaded;
  const mode = config.mixer.mode;
  const dataDir = loaded.dataDir ?? join(process.cwd(), 'data');
  const proxy = httpsLabOptions(config); // valida antes de criar/conectar qualquer mixer
  if (config.server.privatePtt.enabled && (!proxy || mode !== 'lab')) throw new Error('privatePtt exige modo LAB e entrada HTTPS LAB configurada.');
  const hosts = listenHosts(config); // valida a rede ANTES de tocar na mesa
  const port = opts.port ?? serverPort(config);

  const lockFile = ownerLockFile(mode, loaded.labFile);
  const equipment = mode === 'real' ? equipmentLabel(config.mixer) : `laboratório ${loaded.labFile}`;
  const lock = lockFile ? new OwnerLock(lockFile, 'servidor', { install: PROJECT_ROOT, equipment }).acquire() : undefined;
  let recordsLock: OwnerLock | undefined;
  let app: App | undefined;
  let autoConfig: AutoConfigService | undefined;
  let autoConfigAdvisor: AutoConfigAdvisor | undefined;
  let removeAdvisorRevoke: (() => void) | undefined;
  const https: FastifyInstance[] = [];
  const tokenFile = agentTokenFile(dataDir, mode);
  try {
    if (mode === 'lab' || mode === 'mock') recordsLock = new OwnerLock(ownerLockFile('lab', join(dataDir, 'mix-reference-requests.json'))!, 'servidor', { install: PROJECT_ROOT, equipment: 'registros locais LAB/MOCK' }).acquire();
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

    core.musicians = new MusicianAccess(mode === 'lab' ? join(dataDir, 'musician-bindings.json') : undefined);

    // Assistente (E4): parser local sempre; Claude só com ai.enabled e chave (só no servidor).
    const ai = new ClaudeClient(
      config.ai,
      loaded.secrets?.anthropicApiKey,
      new UsageTracker(join(dataDir, 'ai-usage.json'), opts.clock),
      opts.aiFetch ?? fetch,
      opts.clock,
    );
    // Cenas do MixAI (E5): data/scenes/ (fora do Git). Comparar/carregar só no LABORATÓRIO.
    const sceneStore = new SceneStore(join(dataDir, 'scenes'), app.controller.registry, deviceProfileOf(app.mixer.capabilities()), opts.clock);
    core.scenes = new ScenesService(
      app.controller,
      sceneStore,
      app.log,
      { mode, policy: () => core.policy, clock: opts.clock },
    );
    // Base de conhecimento local (opcional, desligada por padrão). Falha dela nunca impede o início.
    let knowledge: LocalKnowledge | undefined = opts.knowledge;
    try {
      knowledge ??= await openLocalKnowledge(loaded, { log: opts.log });
    } catch (err) {
      opts.log?.(`Base de conhecimento desativada: ${(err as Error).message.slice(0, 120).replace(/[\r\n\t]+/g, ' ')}`);
    }
    core.assistant = new AssistantService(core, {
      knowledge,
      knowledgeDeadlineMs: config.knowledge.replyDeadlineMs,
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

    const records = new ReferenceStore(join(dataDir, 'mix-reference-requests.json'));
    autoConfig = (mode === 'lab' || mode === 'mock') && app.mixer.mode === mode ? new AutoConfigService(records, { mode: () => app!.mixer.mode, serverId: core.serverId, active: p => auth.isActive(p), snapshot: () => core.snapshotFor('operator'), channels: () => names.inputs.list(), supports: key => app!.controller.registry.has(key as never), device: deviceProfileOf(app.mixer.capabilities()), scenes: sceneStore }, opts.autoConfigSimulator, opts.clock) : undefined;
    if (mode === 'lab' && app.mixer.mode === 'lab') {
      autoConfigAdvisor = new AutoConfigAdvisor(loaded, names, {
        serverId: core.serverId, mode: () => app!.mixer.mode, active: p => auth.isActive(p),
        connected: () => core.snapshotFor('operator').available,
        stateRevision: () => core.snapshotFor('operator').revision,
        m1: p => core.assistant?.planningContext(p),
        eventVersion: id => records.read().soundchecks.find(e => e.id === id)?.version,
        selectedProvider: () => knowledge?.providers().chat.selected ?? config.knowledge.chatProvider,
        audit: (p, result) => app!.log.add({ action: 'autoconfig_advice', ok: result.outcome === 'returned', message: 'Consulta consultiva AutoConfig; sem rascunho ou autorização automática.', details: { ...result, role: p.role, actor: p.id } }),
      }, undefined, { clock: opts.clock, fetch: opts.autoConfigPlannerFetch, geminiFetch: opts.autoConfigPlannerGeminiFetch });
      removeAdvisorRevoke = auth.onRevoke(id => autoConfigAdvisor?.revoke(id));
    }
    const references = mode === 'lab' && app.mixer.mode === 'lab' ? new ReferenceService(records, {
      mode, serverId: core.serverId, snapshot: () => core.snapshotFor('operator'),
      channels: () => names.inputs.list(), device: deviceProfileOf(app.mixer.capabilities()), scenes: sceneStore,
      supports: key => app!.controller.registry.has(key as never), active: p => auth.isActive(p),
    }, { ...referencePortsOf(core), ...opts.referencePorts }, opts.clock) : undefined;

    let boundPort = port;
    for (const host of hosts) {
      const http = await buildHttp(core, { autoConfig, autoConfigAdvisor, references, knowledge, webRoot: opts.webRoot ?? join(PROJECT_ROOT, 'dist', 'web', 'browser') });
      https.push(http);
      await http.listen({ host, port: boundPort });
      const addr = http.server.address();
      if (addr && typeof addr === 'object') boundPort = addr.port; // porta 0 nos testes
    }
    if (proxy) {
      if (proxy.port === boundPort) throw new Error('HTTPS LAB: porta do proxy deve diferir da porta HTTP local.');
      const ingress = await buildHttp(core, { labProxyOrigin: proxy.origin, autoConfig, autoConfigAdvisor, references, knowledge, privatePtt: config.server.privatePtt.enabled ? new PrivatePtt(config.server.privatePtt, opts.pttRecognizer, opts.clock) : undefined, webRoot: opts.webRoot ?? join(PROJECT_ROOT, 'dist', 'web', 'browser') });
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
        autoConfig?.stop(); autoConfigAdvisor?.stop(); removeAdvisorRevoke?.();
        core.stop();
        await knowledge?.close().catch(() => undefined);
        for (const h of https) await h.close().catch(() => undefined);
        await appRef.mixer.disconnect().catch(() => undefined);
        rmSync(tokenFile, { force: true });
        recordsLock?.release();
        lock?.release();
      },
    };
  } catch (err) {
    autoConfig?.stop(); autoConfigAdvisor?.stop(); removeAdvisorRevoke?.();
    for (const h of https) await h.close().catch(() => undefined);
    await app?.mixer.disconnect().catch(() => undefined);
    recordsLock?.release();
    lock?.release();
    throw err;
  }
}

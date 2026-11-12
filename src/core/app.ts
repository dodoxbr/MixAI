import { ChannelMap } from './channels.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { MixController } from './controller.js';
import { ActionLog } from './log.js';
import { paramKey, type ParamKey } from './revisions.js';
import { LabMixer } from '../mixer/lab.js';
import { MockMixer } from '../mixer/mock.js';
import { auxBus, MASTER, type MixerAdapter, type MixerCapabilities } from '../mixer/types.js';

export interface App {
  loaded: LoadedConfig;
  mixer: MixerAdapter;
  controller: MixController;
  log: ActionLog;
}

/** Capacidades conhecidas sem carregar o código da mesa real. */
const MODEL_CAPS: Record<'ui12' | 'ui16' | 'ui24', MixerCapabilities> = {
  ui12: { model: 'ui12', inputs: 8, aux: 4 },
  ui16: { model: 'ui16', inputs: 12, aux: 6 },
  ui24: { model: 'ui24', inputs: 24, aux: 10 },
};

/** Parâmetros obrigatórios (canais do channels.yaml) e acompanhados (tudo que pode ser resolvido). */
export function keysFor(names: ChannelMap): { required: ParamKey[]; watched: ParamKey[]; nameChannels: number[] } {
  const build = (channels: number[], auxes: number[]) => {
    const keys: ParamKey[] = [paramKey.master()];
    for (const ch of channels) {
      keys.push(paramKey.level(ch, MASTER), paramKey.mute(ch, MASTER));
      for (const a of auxes) keys.push(paramKey.level(ch, auxBus(a)), paramKey.mute(ch, auxBus(a)));
    }
    return keys;
  };
  const required = build(names.inputs.configured(), names.aux.configured());
  const watched = [...new Set([...required, ...build(names.inputs.resolvable(), names.aux.resolvable())])];
  return { required, watched, nameChannels: names.inputs.resolvable() };
}

/**
 * Monta mesa (real, laboratório ou simulada) + controlador. O modo é decidido UMA vez, aqui.
 * Nos modos lab e mock o código da mesa real nem é carregado (import dinâmico).
 */
export async function createApp(loaded: LoadedConfig = loadConfig(), options: { readOnly?: boolean } = {}): Promise<App> {
  const { config } = loaded;
  const caps = MODEL_CAPS[config.mixer.model];
  const names = new ChannelMap(loaded.channels, caps, { allowUnmapped: config.naming.allowUnmapped });
  const log = new ActionLog(loaded.logDir);
  let mixer: MixerAdapter;
  if (config.mixer.mode === 'real') {
    const { RealMixer } = await import('../mixer/real.js');
    const { Ui16RealBridge } = await import('../mixer/ui16-real-bridge.js');
    const keys = keysFor(names);
    const c = config.mixer.connection;
    // Compatibility option readOnly cannot authorize physical writes: hardware gate is pending.
    const Adapter = config.mixer.model === 'ui16' ? Ui16RealBridge : RealMixer;
    mixer = new Adapter({
      readOnly: true,
      ip: config.mixer.ip,
      model: config.mixer.model,
      requiredKeys: keys.required,
      watchedKeys: keys.watched,
      nameChannels: keys.nameChannels,
      connectTimeoutMs: config.mixer.connectTimeoutMs,
      syncTimeoutMs: c.syncTimeoutMs,
      indeterminateWindowMs: c.indeterminateWindowMs,
      reconnectBaseMs: c.reconnectBaseMs,
      reconnectMaxDelayMs: c.reconnectMaxDelayMs,
    });
  } else if (config.mixer.mode === 'lab') {
    mixer = new LabMixer({
      file: loaded.labFile,
      caps,
      saveDebounceMs: config.lab.saveDebounceMs,
      onSaveError: (err) => log.add({ action: 'lab_save', ok: false, message: `Falha ao gravar o laboratório: ${err.message}` }),
    });
  } else {
    mixer = new MockMixer(caps);
  }
  const controller = new MixController(mixer, config.safety, names, log);
  if (mixer instanceof LabMixer) {
    const { source, warnings } = mixer.loadResult;
    log.add({
      action: 'lab_load',
      ok: !warnings.length || source === 'main',
      message: `Laboratório carregado (${source === 'main' ? 'arquivo' : source === 'backup' ? 'BACKUP' : 'estado padrão'}): ${loaded.labFile}`,
      details: { source, warnings },
    });
  }
  return { loaded, mixer, controller, log };
}

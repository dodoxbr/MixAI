import { ChannelMap } from './channels.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { MixController } from './controller.js';
import { ActionLog } from './log.js';
import { paramKey, type ParamKey } from './revisions.js';
import { MockMixer } from '../mixer/mock.js';
import { auxBus, MASTER, type MixerAdapter, type MixerCapabilities } from '../mixer/types.js';

export interface App {
  loaded: LoadedConfig;
  mixer: MixerAdapter;
  controller: MixController;
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
 * Monta mesa (real ou simulada) + controlador. O modo é decidido UMA vez, aqui.
 * No modo mock o código da mesa real nem é carregado (import dinâmico).
 */
export async function createApp(loaded: LoadedConfig = loadConfig()): Promise<App> {
  const { config } = loaded;
  const caps = MODEL_CAPS[config.mixer.model];
  const names = new ChannelMap(loaded.channels, caps, { allowUnmapped: config.naming.allowUnmapped });
  let mixer: MixerAdapter;
  if (config.mixer.mode === 'real') {
    const { RealMixer } = await import('../mixer/real.js');
    const keys = keysFor(names);
    const c = config.mixer.connection;
    mixer = new RealMixer({
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
  } else {
    mixer = new MockMixer(caps);
  }
  const controller = new MixController(mixer, config.safety, names, new ActionLog(loaded.logDir));
  return { loaded, mixer, controller };
}

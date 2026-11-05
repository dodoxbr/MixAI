import { ChannelMap } from './channels.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { MixController } from './controller.js';
import { ActionLog } from './log.js';
import { MockMixer } from '../mixer/mock.js';
import { RealMixer } from '../mixer/real.js';
import type { MixerAdapter } from '../mixer/types.js';

export interface App {
  loaded: LoadedConfig;
  mixer: MixerAdapter;
  controller: MixController;
}

/** Monta mesa (real ou simulada) + controlador a partir da configuração. */
export function createApp(loaded: LoadedConfig = loadConfig()): App {
  const { config } = loaded;
  const mixer: MixerAdapter =
    config.mixer.mode === 'real'
      ? new RealMixer({ ip: config.mixer.ip, model: config.mixer.model, connectTimeoutMs: config.mixer.connectTimeoutMs })
      : new MockMixer();
  const names = new ChannelMap(loaded.channels, mixer.capabilities());
  const controller = new MixController(mixer, config.safety, names, new ActionLog(loaded.logDir));
  return { loaded, mixer, controller };
}

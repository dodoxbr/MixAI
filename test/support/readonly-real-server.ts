import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  parseChannels,
  parseConfig,
  PROJECT_ROOT,
  type LoadedConfig,
} from '../../src/core/config.js';
import { ChannelMap } from '../../src/core/channels.js';
import { keysFor } from '../../src/core/app.js';
import { ChannelSettings } from '../../src/core/channel-settings.js';
import { Ui16RealBridge } from '../../src/mixer/ui16-real-bridge.js';
import { MixController } from '../../src/core/controller.js';
import { ActionLog } from '../../src/core/log.js';
import { Auth } from '../../src/server/auth.js';
import { hashPin } from '../../src/server/pin.js';
import { ServerCore } from '../../src/server/core.js';
import { AssistantService } from '../../src/assistant/service.js';
import { buildHttp } from '../../src/server/http.js';
import { createFakeUi, stateMessages, waitFor } from './fake-ui-socket.js';
export async function readonlyRealServer(
  options: { missingMute?: boolean; aux2?: boolean } = {},
) {
  const channels = parseChannels(
    parse(readFileSync(join(PROJECT_ROOT, 'config/channels.yaml'), 'utf8')),
  );
  if (options.aux2)
    channels.aux.push({ number: 2, name: 'Monitor palco', aliases: ['palco'] });
  const loaded: LoadedConfig = {
    config: parseConfig({ mixer: { mode: 'real' } }),
    channels,
    configDir: mkdtempSync(join(tmpdir(), 'mixai-names-')),
    logDir: null,
    labFile: 'unused',
    dataDir: undefined,
  };
  loaded.dataDir = join(loaded.configDir, 'data');
  writeFileSync(
    join(loaded.configDir, 'channels.yaml'),
    '# preserved comment\n' + stringify(channels),
  );
  const caps = { model: 'ui16', inputs: 12, aux: 6 },
    names = new ChannelMap(channels, caps, { allowUnmapped: false }),
    keys = keysFor(names);
  const initial = () => [
    ...stateMessages({
      channels: names.inputs.configured(),
      aux: names.aux.configured(),
    }).filter(
      (line) => !options.missingMute || !line.startsWith('SETD^i.0.mute^'),
    ),
    ...names.inputs
      .configured()
      .map((ch) => `SETS^i.${ch - 1}.name^Mesa CH${ch}`),
  ];
  const fake = createFakeUi({ initialState: initial });
  const mixer = new Ui16RealBridge({
    ip: 'fixture.invalid',
    requiredKeys: keys.required,
    watchedKeys: keys.watched,
    nameChannels: keys.nameChannels,
    webSocketCtor: fake.Ctor,
    reconnectBaseMs: 5,
    reconnectMaxDelayMs: 10,
    syncTimeoutMs: 30,
  });
  const log = new ActionLog(null),
    controller = new MixController(mixer, loaded.config.safety, names, log);
  const auth = new Auth({
    operatorPinHash: hashPin('4321'),
    musicianPinHash: hashPin('1357'),
    agentToken: 'fixture-agent',
  });
  const core = new ServerCore(controller, mixer, 'real', auth, log, {
    musicianAux: 1,
  });
  core.assistant = new AssistantService(core, {
    steps: loaded.config.assistant,
    channels: channels.channels,
    ttlMs: 15000,
    log,
  });
  const settings = new ChannelSettings(loaded, names, mixer, () =>
    core.namesChanged(),
  );
  const app = await buildHttp(core, {
    channelSettings: settings,
    webRoot: join(PROJECT_ROOT, 'dist/web/browser'),
  });
  await mixer.connect();
  await waitFor(() => mixer.link() === 'READY');
  const login = auth.login('4321', 'fixture');
  if (!login.ok) throw Error('fixture login');
  return {
    app,
    core,
    mixer,
    fake,
    controller,
    settings,
    loaded,
    token: login.token,
    principal: login.principal,
    close: async () => {
      core.assistant?.stop();
      await app.close();
      await mixer.disconnect();
    },
  };
}

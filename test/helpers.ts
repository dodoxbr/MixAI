import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ChannelMap } from '../src/core/channels.js';
import { parseChannels, parseConfig, PROJECT_ROOT, type SafetyConfig } from '../src/core/config.js';
import { MixController, type Result } from '../src/core/controller.js';
import { ActionLog } from '../src/core/log.js';
import { MockMixer } from '../src/mixer/mock.js';

/** Fixture fixa: os testes não quebram quando a banda muda o channels.yaml. */
export function fixtureChannels() {
  return parseChannels(parse(readFileSync(join(PROJECT_ROOT, 'test', 'fixtures', 'channels.yaml'), 'utf8')));
}

/**
 * Executa um comando que pode pedir confirmação: pede, e se vier uma pendência, confirma com o id.
 * Substitui o antigo `confirm: true` (que deixou de executar sozinho na E0).
 */
export async function confirmed(run: (confirmationId?: string) => Promise<Result>): Promise<Result> {
  const first = await run();
  if (!first.needsConfirmation) return first;
  if (!first.pendingId) throw new Error('pendência sem pendingId');
  return run(first.pendingId);
}

export async function setup(safety: Partial<SafetyConfig> = {}) {
  const mixer = new MockMixer();
  await mixer.connect();
  const cfg = parseConfig({ safety });
  let now = 1_000_000;
  const clock = { tick: (ms: number) => (now += ms), now: () => now };
  const log = new ActionLog(null);
  const names = new ChannelMap(fixtureChannels(), mixer.capabilities());
  const controller = new MixController(mixer, cfg.safety, names, log, clock.now);
  return { mixer, controller, clock, log };
}

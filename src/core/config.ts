import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const SafetySchema = z.object({
  maxChannelLevelDB: z.number().max(10).default(0),
  maxAuxSendDB: z.number().max(10).default(0),
  maxMasterLevelDB: z.number().max(10).default(0),
  maxStepDB: z.number().positive().default(6),
  masterRequiresConfirmation: z.boolean().default(true),
  bulkMuteConfirmAbove: z.number().int().min(1).default(2),
  maxActionsPerSecond: z.number().int().positive().default(5),
  relativeFloorDB: z.number().default(-60),
});

const ConfigSchema = z.object({
  mixer: z
    .object({
      mode: z.enum(['mock', 'real']).default('mock'),
      ip: z.string().default('10.10.1.1'),
      model: z.enum(['ui12', 'ui16', 'ui24']).default('ui16'),
      connectTimeoutMs: z.number().int().positive().default(8000),
    })
    .prefault({}),
  safety: SafetySchema.prefault({}),
  logs: z.object({ dir: z.string().nullable().default('logs') }).prefault({}),
});

const NamedSchema = z.object({
  number: z.number().int().positive(),
  name: z.string().min(1),
  aliases: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
});

const ChannelsSchema = z.object({
  channels: z.array(NamedSchema).default([]),
  aux: z.array(NamedSchema).default([]),
});

export type SafetyConfig = z.infer<typeof SafetySchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;
export type NamedEntry = z.infer<typeof NamedSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsSchema>;

/** Pasta raiz do projeto (onde ficam config/ e logs/). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseConfig(raw: unknown): AppConfig {
  return ConfigSchema.parse(raw ?? {});
}
export function parseChannels(raw: unknown): ChannelsConfig {
  return ChannelsSchema.parse(raw ?? {});
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Erro ao ler ${path}: ${(err as Error).message}`);
  }
}

export interface LoadedConfig {
  config: AppConfig;
  channels: ChannelsConfig;
  configDir: string;
  logDir: string | null;
}

/** Carrega config.yaml e channels.yaml, aplicando as variáveis de ambiente e as flags --mock / --real. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): LoadedConfig {
  const configDir = env.MIXAI_CONFIG_DIR ? resolve(env.MIXAI_CONFIG_DIR) : join(PROJECT_ROOT, 'config');
  const config = parseConfig(readYaml(join(configDir, 'config.yaml')));
  const channels = parseChannels(readYaml(join(configDir, 'channels.yaml')));

  if (env.MIXAI_MODE === 'mock' || env.MIXAI_MODE === 'real') config.mixer.mode = env.MIXAI_MODE;
  if (argv.includes('--mock')) config.mixer.mode = 'mock';
  if (argv.includes('--real')) config.mixer.mode = 'real';
  if (env.MIXAI_IP) config.mixer.ip = env.MIXAI_IP;

  let logDir: string | null = env.MIXAI_LOG_DIR ?? config.logs.dir;
  if (logDir && !isAbsolute(logDir)) logDir = join(PROJECT_ROOT, logDir);
  return { config, channels, configDir, logDir };
}

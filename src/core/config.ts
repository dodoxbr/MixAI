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
      /** lab = laboratório persistente · mock = simulador em memória (testes) · real = Ui16 física */
      mode: z.enum(['mock', 'lab', 'real']).default('mock'),
      ip: z.string().default('10.10.1.1'),
      model: z.enum(['ui12', 'ui16', 'ui24']).default('ui16'),
      connectTimeoutMs: z.number().int().positive().default(8000),
      connection: z
        .object({
          /** Tempo máximo esperando o estado completo da mesa depois de conectar. */
          syncTimeoutMs: z.number().int().positive().default(5000),
          /** Escritas enviadas até este tempo antes de uma queda são verificadas na ressincronização. */
          indeterminateWindowMs: z.number().int().positive().default(3000),
          reconnectBaseMs: z.number().int().positive().default(1000),
          reconnectMaxDelayMs: z.number().int().positive().default(10000),
        })
        .strict()
        .prefault({}),
    })
    .prefault({}),
  lab: z
    .object({
      /** Arquivo de estado do laboratório (relativo à pasta do projeto). */
      stateFile: z.string().default('data/lab-state.json'),
      /** Espera antes de gravar, juntando mudanças seguidas. */
      saveDebounceMs: z.number().int().min(0).default(300),
    })
    .prefault({}),
  naming: z
    .object({
      /** false = só canais/AUX do channels.yaml podem ser alterados. */
      allowUnmapped: z.boolean().default(false),
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
  /** Caminho absoluto do arquivo de estado do laboratório. */
  labFile: string;
}

/** Carrega config.yaml e channels.yaml, aplicando as variáveis de ambiente e as flags --lab / --mock / --real. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): LoadedConfig {
  const configDir = env.MIXAI_CONFIG_DIR ? resolve(env.MIXAI_CONFIG_DIR) : join(PROJECT_ROOT, 'config');
  const config = parseConfig(readYaml(join(configDir, 'config.yaml')));
  const channels = parseChannels(readYaml(join(configDir, 'channels.yaml')));

  // Precedência: config.yaml < MIXAI_MODE < --lab < --mock < --real
  if (env.MIXAI_MODE === 'mock' || env.MIXAI_MODE === 'lab' || env.MIXAI_MODE === 'real') config.mixer.mode = env.MIXAI_MODE;
  if (argv.includes('--lab')) config.mixer.mode = 'lab';
  if (argv.includes('--mock')) config.mixer.mode = 'mock';
  if (argv.includes('--real')) config.mixer.mode = 'real';
  if (env.MIXAI_IP) config.mixer.ip = env.MIXAI_IP;

  let logDir: string | null = env.MIXAI_LOG_DIR ?? config.logs.dir;
  if (logDir && !isAbsolute(logDir)) logDir = join(PROJECT_ROOT, logDir);
  let labFile = env.MIXAI_LAB_FILE || config.lab.stateFile;
  if (!isAbsolute(labFile)) labFile = join(PROJECT_ROOT, labFile);
  return { config, channels, configDir, logDir, labFile };
}

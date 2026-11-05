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
  server: z
    .object({
      /** Porta. Vazio = padrão do modo: LAB/mock 8790, REAL 8791. */
      port: z.number().int().min(1024).max(65535).optional(),
      /**
       * Acesso pela rede local (celulares no Wi-Fi). Desligado por padrão: o servidor só escuta em
       * 127.0.0.1. Quando ligado, escuta TAMBÉM no IP informado (o da interface Wi-Fi do notebook),
       * nunca em 0.0.0.0 e nunca no IP da mesa.
       */
      lan: z
        .object({
          enabled: z.boolean().default(false),
          host: z.string().default(''),
        })
        .prefault({}),
      /** AUX que os músicos podem ajustar (o retorno compartilhado dos fones). */
      musicianAux: z.number().int().min(1).default(1),
      /** Validade de uma sessão aberta com PIN (horas). */
      sessionHours: z.number().positive().max(48).default(12),
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

/** Segredos locais (config/secrets.yaml, fora do Git): só HASHES de PIN, nunca o PIN. */
const SecretsSchema = z.object({
  operatorPinHash: z.string().optional(),
  musicianPinHash: z.string().optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

export const DEFAULT_PORTS = { lab: 8790, mock: 8790, real: 8791 } as const;

export function serverPort(config: AppConfig): number {
  return config.server.port ?? DEFAULT_PORTS[config.mixer.mode];
}

export interface LoadedConfig {
  config: AppConfig;
  channels: ChannelsConfig;
  configDir: string;
  logDir: string | null;
  /** Caminho absoluto do arquivo de estado do laboratório. */
  labFile: string;
  /** Pasta de dados locais (fora do Git): estado do laboratório, travas, token do assistente. */
  dataDir?: string;
  /** Hashes de PIN (config/secrets.yaml ou variáveis de ambiente). */
  secrets?: Secrets;
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
  if (env.MIXAI_PORT) config.server.port = Number(env.MIXAI_PORT);
  if (env.MIXAI_LAN_HOST) config.server.lan = { enabled: true, host: env.MIXAI_LAN_HOST };

  const secrets = SecretsSchema.parse(readYaml(join(configDir, 'secrets.yaml')) ?? {});
  if (env.MIXAI_OPERATOR_PIN_HASH) secrets.operatorPinHash = env.MIXAI_OPERATOR_PIN_HASH;
  if (env.MIXAI_MUSICIAN_PIN_HASH) secrets.musicianPinHash = env.MIXAI_MUSICIAN_PIN_HASH;
  const dataDir = env.MIXAI_DATA_DIR ? resolve(env.MIXAI_DATA_DIR) : join(PROJECT_ROOT, 'data');

  let logDir: string | null = env.MIXAI_LOG_DIR ?? config.logs.dir;
  if (logDir && !isAbsolute(logDir)) logDir = join(PROJECT_ROOT, logDir);
  let labFile = env.MIXAI_LAB_FILE || config.lab.stateFile;
  if (!isAbsolute(labFile)) labFile = join(PROJECT_ROOT, labFile);
  return { config, channels, configDir, logDir, labFile, dataDir, secrets };
}

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
      /** Entrada loopback exclusiva do proxy HTTPS LAB. Nunca recebe o token MCP. */
      httpsLab: z.object({
        enabled: z.boolean().default(false),
        origin: z.string().default(''),
        port: z.number().int().min(1024).max(65535).default(8792),
      }).strict().prefault({}),
      /** E9D: opt-in exclusivo da entrada HTTPS LAB. Caminhos locais, nunca públicos. */
      privatePtt: z.object({
        enabled: z.boolean().default(false),
        executable: z.string().optional(),
        model: z.string().optional(),
      }).strict().prefault({}),
      /** AUX que os músicos podem ajustar (o retorno compartilhado dos fones). */
      musicianAux: z.number().int().min(1).default(1),
      /**
       * O que o perfil músico pode fazer:
       * - fones_only (padrão): só os fones;
       * - pa_without_master: fones + canais do PA (passos pequenos, mute de um canal), nunca o master.
       */
      musicianAccess: z.enum(['fones_only', 'pa_without_master']).default('fones_only'),
      /** Maior mudança de um canal do PA que o músico faz sem aprovação (dB, até 3). */
      musicianPaStepDB: z.number().positive().max(3).default(3),
      /** Validade de uma sessão aberta com PIN (horas). */
      sessionHours: z.number().positive().max(48).default(12),
    })
    .prefault({}),
  /** Assistente de texto (E4): parser local + Claude opcional. Tudo vira proposta com "Aplicar". */
  assistant: z
    .object({
      /** "um pouco", "um pouquinho", "levemente" (e o padrão quando não diz quanto). */
      smallStepDB: z.number().positive().max(6).default(2),
      /** "mais" ("aumenta mais o surdo"). */
      mediumStepDB: z.number().positive().max(6).default(3),
      /** "bastante", "muito". */
      largeStepDB: z.number().positive().max(12).default(5),
      /** Validade de uma proposta antes de tocar em Aplicar. */
      proposalTtlSec: z.number().int().min(10).max(600).default(120),
    })
    .prefault({}),
  /** Claude (API da Anthropic). Opcional: desligado sem chave. A chave fica só no servidor. */
  ai: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().min(1).default('claude-haiku-5-5'),
      /** Máximo de tokens na resposta da IA. */
      maxOutputTokens: z.number().int().min(64).max(4000).default(600),
      /** Pedido do usuário maior que isso é recusado (não vai para a API). */
      maxInputChars: z.number().int().min(20).max(2000).default(400),
      timeoutMs: z.number().int().min(1000).max(60_000).default(12_000),
      /** Teto de gasto por dia (US$, estimado pelos preços abaixo). */
      dailyBudgetUSD: z.number().min(0).default(0.5),
      maxRequestsPerMinute: z.number().int().min(1).max(60).default(6),
      /** Preço por milhão de tokens (US$). Padrão: Claude Haiku 5.5. Confira em platform.claude.com/docs/en/about-claude/pricing. */
      priceInputPerMTok: z.number().min(0).default(0.1),
      priceOutputPerMTok: z.number().min(0).default(0.5),
      /** Quantas trocas anteriores vão junto (contexto curto). */
      historyTurns: z.number().int().min(0).max(10).default(4),
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

/** Campos que NUNCA podem ir no config.local.yaml (segredos ficam em secrets.yaml ou no ambiente). */
const SECRET_KEYS = /^(operatorpinhash|musicianpinhash|anthropicapikey|apikey|api_key|pin|pins|password|senha|token|secret)$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Mescla a configuração local sobre a do repositório: objetos são mesclados campo a campo;
 * valores simples e listas SUBSTITUEM. Só o que está declarado no arquivo local muda.
 */
export function mergeConfig(base: unknown, local: unknown): unknown {
  if (!isPlainObject(local)) return base;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(local)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k], v) : v;
  }
  return out;
}

/** Recusa segredos no config.local.yaml (o arquivo não é tratado como secreto). */
function assertNoSecrets(value: unknown, file: string, path: string[] = []): void {
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) {
      throw new Error(
        `${file}: o campo "${[...path, k].join('.')}" é um segredo e não pode ficar aqui. PINs: "npm run pin"; chave da API: config/secrets.yaml ou ANTHROPIC_API_KEY.`,
      );
    }
    assertNoSecrets(v, file, [...path, k]);
  }
}

/** Nome do arquivo de configuração local (fora do Git), na mesma pasta do config.yaml. */
export const LOCAL_CONFIG_FILE = 'config.local.yaml';

/** Segredos locais (config/secrets.yaml, fora do Git): só HASHES de PIN, nunca o PIN. */
const SecretsSchema = z.object({
  operatorPinHash: z.string().optional(),
  musicianPinHash: z.string().optional(),
  /** Chave da API da Anthropic (opcional). Só o servidor lê; nunca vai para o navegador nem para o log. */
  anthropicApiKey: z.string().optional(),
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
  /** Caminho do config.local.yaml, se existir e tiver sido aplicado. */
  localConfigFile?: string;
}

/**
 * Carrega config.yaml (+ config.local.yaml) e channels.yaml, aplicando as variáveis de ambiente
 * e as flags --lab / --mock / --real.
 *
 * Precedência (o de baixo vence): config.yaml < config.local.yaml < variáveis de ambiente <
 * argumentos de inicialização. O config.local.yaml é da máquina (fora do Git): IP do Wi-Fi,
 * porta, política dos músicos... nunca segredos.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): LoadedConfig {
  const configDir = env.MIXAI_CONFIG_DIR ? resolve(env.MIXAI_CONFIG_DIR) : join(PROJECT_ROOT, 'config');
  const localPath = join(configDir, LOCAL_CONFIG_FILE);
  const local = readYaml(localPath);
  if (local !== null && local !== undefined && !isPlainObject(local)) throw new Error(`${localPath}: esperado um mapa YAML (campo: valor).`);
  assertNoSecrets(local, localPath);
  let config: AppConfig;
  try {
    config = parseConfig(mergeConfig(readYaml(join(configDir, 'config.yaml')), local));
  } catch (err) {
    const where = existsSync(localPath) ? ` (confira também ${localPath})` : '';
    throw new Error(`Configuração inválida${where}: ${(err as Error).message}`);
  }
  const channels = parseChannels(readYaml(join(configDir, 'channels.yaml')));

  // Precedência: config.yaml < config.local.yaml < MIXAI_MODE < --lab < --mock < --real
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
  if (env.ANTHROPIC_API_KEY) secrets.anthropicApiKey = env.ANTHROPIC_API_KEY;
  const dataDir = env.MIXAI_DATA_DIR ? resolve(env.MIXAI_DATA_DIR) : join(PROJECT_ROOT, 'data');

  let logDir: string | null = env.MIXAI_LOG_DIR ?? config.logs.dir;
  if (logDir && !isAbsolute(logDir)) logDir = join(PROJECT_ROOT, logDir);
  let labFile = env.MIXAI_LAB_FILE || config.lab.stateFile;
  if (!isAbsolute(labFile)) labFile = join(PROJECT_ROOT, labFile);
  return { config, channels, configDir, logDir, labFile, dataDir, secrets, localConfigFile: existsSync(localPath) ? localPath : undefined };
}

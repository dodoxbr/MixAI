import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { OwnerLock } from './owner-lock.js';
import { z } from 'zod';
import {
  parseChannels,
  type ChannelsConfig,
  type LoadedConfig,
} from './config.js';
import { words, channelTermKeys, type ChannelMap } from './channels.js';
import type { MixerAdapter } from '../mixer/types.js';
const text = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (s) => !/[\p{C}\p{Zl}\p{Zp}]/u.test(s),
    'Nome contém caracteres de controle.',
  );
const row = z.strictObject({
  number: z.number().int().positive(),
  name: text,
  aliases: z.array(text).max(30),
});
export const channelSettingsUpdate = z.strictObject({
  serverId: z.string().uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  channels: z.array(row).max(64),
  aux: z.array(row).max(16),
});
const revision = (raw: string) =>
  createHash('sha256').update(raw).digest('hex');
export class ChannelSettingsError extends Error {
  constructor(
    readonly code: 'INVALID' | 'CONFLICT' | 'UNAVAILABLE' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
  }
}
/** Validates precisely the same normalization/prefix rules as the existing resolver. */
export function validateChannelSettings(
  next: ChannelsConfig,
  current: ChannelsConfig,
  caps: { inputs: number; aux: number },
) {
  for (const kind of ['channels', 'aux'] as const) {
    const ids = next[kind].map((e) => e.number).sort((a, b) => a - b),
      expected = current[kind].map((e) => e.number).sort((a, b) => a - b);
    if (
      new Set(ids).size !== ids.length ||
      JSON.stringify(ids) !== JSON.stringify(expected)
    )
      throw new ChannelSettingsError(
        'INVALID',
        'Números físicos, inclusão e exclusão de canais/AUX não podem ser alterados nesta tela.',
      );
    const owners = new Map<string, number>();
    for (let n = 1; n <= (kind === 'channels' ? caps.inputs : caps.aux); n++)
      owners.set(String(n), n);
    const phrases: Array<{ text: string; owner: number }> = [];
    for (const entry of next[kind])
      for (const term of [entry.name, ...entry.aliases]) {
        const phrase = words(term).join(' ');
        if (
          kind === 'channels' &&
          [
            'pa',
            'master',
            'fones',
            'todos',
            'tudo',
            'mute',
            'desfazer',
          ].includes(phrase)
        )
          throw new ChannelSettingsError(
            'INVALID',
            'Nome reservado para destino ou comando.',
          );
        for (const other of phrases)
          if (
            other.owner !== entry.number &&
            (` ${other.text} `.includes(` ${phrase} `) ||
              ` ${phrase} `.includes(` ${other.text} `))
          )
            throw new ChannelSettingsError(
              'INVALID',
              `Apelido ambíguo no reconhecimento: “${term}”.`,
            );
        phrases.push({ text: phrase, owner: entry.number });
        for (const key of channelTermKeys(term, kind)) {
          if (!key)
            throw new ChannelSettingsError(
              'INVALID',
              'Nome/apelido sem letras ou números.',
            );
          const owner = owners.get(key);
          if (owner !== undefined && owner !== entry.number)
            throw new ChannelSettingsError(
              'INVALID',
              `Nome ou apelido ambíguo em ${kind === 'channels' ? 'canais' : 'AUX'}: “${term}”.`,
            );
          owners.set(key, entry.number);
        }
      }
  }
}
/** The only persisted source remains config/channels.yaml. No mixer write capability is used. */
export class ChannelSettings {
  readonly file: string;
  constructor(
    private loaded: LoadedConfig,
    private names: ChannelMap,
    private mixer: MixerAdapter,
    private changed: () => void,
  ) {
    this.file = join(loaded.configDir, 'channels.yaml');
  }
  private read() {
    try {
      const raw = readFileSync(this.file, 'utf8');
      if (Buffer.byteLength(raw) > 256 * 1024) throw Error('large');
      const doc = parseDocument(raw);
      if (doc.errors.length || !isMap(doc.contents)) throw Error('yaml');
      const config = parseChannels(doc.toJS());
      for (const kind of ['channels', 'aux'] as const)
        if (
          JSON.stringify(
            config[kind].map((e) => e.number).sort((a, b) => a - b),
          ) !==
          JSON.stringify(
            this.names
              .configuration()
              [kind].map((e) => e.number)
              .sort((a, b) => a - b),
          )
        )
          throw new ChannelSettingsError(
            'CONFLICT',
            'O cadastro físico mudou em disco. Revise o arquivo e reinicie o servidor antes de editar nomes.',
          );
      return { raw, doc, config, revision: revision(raw) };
    } catch (error) {
      if (error instanceof ChannelSettingsError) throw error;
      throw new ChannelSettingsError(
        'UNAVAILABLE',
        'Não foi possível ler channels.yaml; o cadastro atual foi preservado.',
      );
    }
  }
  snapshot() {
    const r = this.read();
    return {
      revision: r.revision,
      ...r.config,
      active: this.names.configuration(),
      mixerNames: r.config.channels.map((entry) => ({
        number: entry.number,
        name: this.mixer.channelName(entry.number) ?? null,
        source: 'device_reported' as const,
      })),
      sharedAux: 1,
    };
  }
  save(
    input: z.infer<typeof channelSettingsUpdate>,
    authorized: () => boolean = () => true,
  ) {
    const parsed = channelSettingsUpdate.safeParse(input);
    if (!parsed.success)
      throw new ChannelSettingsError('INVALID', 'Confira nomes e apelidos.');
    const lock = new OwnerLock(
      this.file + '.edit.lock',
      'configuração de nomes',
    );
    try {
      lock.acquire(0);
    } catch {
      throw new ChannelSettingsError(
        'CONFLICT',
        'Outro processo está salvando o cadastro. Recarregue antes de repetir.',
      );
    }
    try {
      return this.saveLocked(parsed.data, authorized);
    } finally {
      lock.release();
    }
  }
  private saveLocked(
    input: z.infer<typeof channelSettingsUpdate>,
    authorized: () => boolean,
  ) {
    if (!authorized())
      throw new ChannelSettingsError(
        'FORBIDDEN',
        'Sessão encerrada antes de salvar.',
      );
    const before = this.read();
    if (input.revision !== before.revision)
      throw new ChannelSettingsError(
        'CONFLICT',
        'O arquivo mudou desde a abertura. Recarregue antes de salvar.',
      );
    const next = parseChannels(input);
    validateChannelSettings(
      next,
      this.names.configuration(),
      this.mixer.capabilities(),
    );
    for (const kind of ['channels', 'aux'] as const) {
      const sequence = before.doc.get(kind);
      if (!isSeq(sequence))
        throw new ChannelSettingsError(
          'INVALID',
          'Cadastro YAML incompatível; nenhum dado foi apagado.',
        );
      for (const item of sequence.items) {
        if (!isMap(item))
          throw new ChannelSettingsError('INVALID', 'Entrada YAML inválida.');
        const update = next[kind].find((e) => e.number === item.get('number'))!;
        item.set('name', update.name);
        item.set('aliases', before.doc.createNode(update.aliases));
      }
    }
    const backup = join(
      this.loaded.dataDir ?? join(this.loaded.configDir, '..', 'data'),
      'channel-config-backups',
    );
    const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      mkdirSync(backup, { recursive: true });
      const old = join(backup, before.revision + '.yaml');
      if (!existsSync(old))
        writeFileSync(old, before.raw, { flag: 'wx', mode: 0o600 });
      writeFileSync(temporary, before.doc.toString(), {
        flag: 'wx',
        mode: statSync(this.file).mode & 0o777,
      });
      if (revision(readFileSync(this.file, 'utf8')) !== before.revision)
        throw new ChannelSettingsError(
          'CONFLICT',
          'O arquivo mudou durante a gravação. Recarregue.',
        );
      if (!authorized())
        throw new ChannelSettingsError(
          'FORBIDDEN',
          'Sessão encerrada antes de salvar.',
        );
      renameSync(temporary, this.file);
    } catch (error) {
      if (error instanceof ChannelSettingsError) throw error;
      throw new ChannelSettingsError(
        'UNAVAILABLE',
        'Não foi possível salvar; o cadastro em memória foi preservado.',
      );
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.names.updateNames(next);
    // Preserve array/object references already held by the assistant and other services.
    for (const kind of ['channels', 'aux'] as const)
      for (const entry of this.loaded.channels[kind]) {
        const update = next[kind].find((e) => e.number === entry.number)!;
        entry.name = update.name;
        entry.aliases.splice(0, entry.aliases.length, ...update.aliases);
      }
    this.changed();
    return this.snapshot();
  }
}

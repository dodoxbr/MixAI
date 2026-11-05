#!/usr/bin/env node
/**
 * Console de teste do MixAI, sem IA: serve para o primeiro contato com a mesa (Fase 0)
 * e para conferir as travas. Uso: npm run console (mesa real) ou npm run console:mock.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createApp } from './core/app.js';
import type { MixController, Result } from './core/controller.js';
import { NameResolutionError } from './core/channels.js';

const HELP = `Comandos (retorno opcional com "@", ex.: "sobe voz 1 3 @ cavaco"):
  status                      conexão e snapshot atual
  estado [@ retorno]          volumes e mutes
  sobe <canal> [dB]           sobe (padrão 2 dB)
  desce <canal> [dB]          desce (padrão 2 dB)
  nivel <canal> <dB>          valor absoluto (ex.: nivel cavaco -12)
  muta <canal, canal...>      muta
  abre <canal, canal...>      desmuta
  master <dB>                 volume geral (pede confirmação)
  desfazer [n]                desfaz as últimas n ações
  snapshots                   lista shows/snapshots
  carrega <show> / <snap>     carrega snapshot (pede confirmação)
  nomes                       nomes da banda
  log                         últimas ações
  ajuda | sair`;

type Run = (confirm: boolean) => Promise<Result>;

function splitAux(rest: string): { body: string; aux?: string } {
  const i = rest.indexOf('@');
  if (i < 0) return { body: rest.trim() };
  return { body: rest.slice(0, i).trim(), aux: rest.slice(i + 1).trim() || undefined };
}

/** "voz 1 3" -> canal "voz 1", valor 3. "voz 1" -> canal "voz 1", sem valor. */
function channelAndValue(c: MixController, body: string): { channel: string; value?: number } {
  const tryChannel = (s: string) => {
    try {
      c.names.channel(s);
      return true;
    } catch (e) {
      if (e instanceof NameResolutionError) return false;
      throw e;
    }
  };
  if (tryChannel(body)) return { channel: body };
  const m = body.match(/^(.*\S)\s+([+-]?\d+(?:[.,]\d+)?)$/);
  if (m) return { channel: m[1]!, value: Number(m[2]!.replace(',', '.')) };
  return { channel: body };
}

function print(result: Result) {
  const mark = result.ok ? '✔' : result.needsConfirmation ? '?' : '✖';
  console.log(`${mark} ${result.message}`);
  const channels = result.data?.channels as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(channels) && channels.length && 'level' in channels[0]!) {
    for (const ch of channels) {
      const name = String(ch.name).padEnd(14);
      console.log(`   ${String(ch.channel).padStart(2)}  ${name} ${String(ch.level).padStart(8)}  ${ch.muted ? 'MUTE' : ''}`);
    }
    if (result.data?.master) console.log(`   Master            ${String(result.data.master).padStart(8)}`);
  } else if (result.data && !('fromDB' in result.data) && !('undone' in result.data)) {
    console.log(JSON.stringify(result.data, null, 2));
  }
}

function parse(c: MixController, line: string): Run | 'help' | 'quit' | string {
  const [cmd = '', ...words] = line.trim().split(/\s+/);
  const rest = words.join(' ');
  switch (cmd.toLowerCase()) {
    case '':
      return '';
    case 'ajuda':
    case 'help':
      return 'help';
    case 'sair':
    case 'exit':
      return 'quit';
    case 'status':
      return () => c.ensureConnected();
    case 'estado':
      return () => c.mixState(splitAux(rest).aux);
    case 'nomes':
      return async () => c.listNames();
    case 'log':
      return async () => c.history(15);
    case 'snapshots':
      return () => c.listSnapshots();
    case 'desfazer':
      return () => c.undo(Number(rest) || 1);
    case 'sobe':
    case 'desce': {
      const { body, aux } = splitAux(rest);
      const { channel, value } = channelAndValue(c, body);
      const amount = Math.abs(value ?? 2) * (cmd === 'desce' ? -1 : 1);
      return (confirm) => c.setLevel({ channel, aux, deltaDB: amount, confirm });
    }
    case 'nivel': {
      const { body, aux } = splitAux(rest);
      const { channel, value } = channelAndValue(c, body);
      if (value === undefined) return 'Informe o valor em dB. Ex.: nivel cavaco -12';
      return (confirm) => c.setLevel({ channel, aux, db: value, confirm });
    }
    case 'muta':
    case 'abre': {
      const { body, aux } = splitAux(rest);
      const channels = body.split(',').map((s) => s.trim()).filter(Boolean);
      return (confirm) => c.setMute({ channels, muted: cmd === 'muta', aux, confirm });
    }
    case 'master': {
      const value = Number(rest.replace(',', '.'));
      if (!rest || Number.isNaN(value)) return 'Informe o valor em dB. Ex.: master -3';
      return (confirm) => c.setMaster({ db: value, confirm });
    }
    case 'carrega': {
      const [show, snapshot] = rest.split('/').map((s) => s.trim());
      if (!show || !snapshot) return 'Use: carrega <show> / <snapshot>';
      return (confirm) => c.loadSnapshot({ show, snapshot, confirm });
    }
    default:
      return `Comando desconhecido: ${cmd}. Digite "ajuda".`;
  }
}

/** Leitor de linhas que não perde nada quando os comandos chegam colados (ex.: entrada por arquivo). */
function lineReader() {
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const queue: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()!(null);
  });
  return {
    question(prompt: string): Promise<string | null> {
      stdout.write(prompt);
      if (queue.length) {
        const line = queue.shift()!;
        if (!stdin.isTTY) stdout.write(line + '\n');
        return Promise.resolve(line);
      }
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) =>
        waiting.push((line) => {
          if (line !== null && !stdin.isTTY) stdout.write(line + '\n');
          resolve(line);
        }),
      );
    },
    close: () => rl.close(),
  };
}

async function main() {
  const { loaded, mixer, controller } = createApp();
  const rl = lineReader();
  console.log(`MixAI console — ${loaded.config.mixer.mode === 'mock' ? 'mesa SIMULADA' : `mesa real em ${loaded.config.mixer.ip}`}`);
  print(await controller.ensureConnected());
  console.log('Digite "ajuda" para ver os comandos.');

  while (true) {
    const line = await rl.question('mixai> ');
    if (line === null) break; // entrada fechada (Ctrl+D)
    const parsed = parse(controller, line);
    if (parsed === 'quit') break;
    if (parsed === 'help') {
      console.log(HELP);
      continue;
    }
    if (typeof parsed === 'string') {
      if (parsed) console.log(parsed);
      continue;
    }
    try {
      let result = await parsed(false);
      print(result);
      if (result.needsConfirmation) {
        const answer = ((await rl.question('Confirmar? (s/n) ')) ?? '').trim().toLowerCase();
        if (answer === 's' || answer === 'sim') {
          result = await parsed(true);
          print(result);
        } else console.log('Cancelado.');
      }
    } catch (err) {
      console.log(`✖ Erro: ${(err as Error).message}`);
    }
  }
  rl.close();
  await mixer.disconnect().catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

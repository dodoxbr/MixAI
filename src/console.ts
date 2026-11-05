#!/usr/bin/env node
/**
 * Console de teste do MixAI, sem IA: serve para o primeiro contato com a mesa (Fase 0)
 * e para conferir as travas. Uso: npm run console (mesa real) ou npm run console:mock.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createApp } from './core/app.js';
import type { Result } from './core/controller.js';
import { HELP, parseCommand, runCommand } from './core/parser.js';

function print(result: Result) {
  const mark = result.ok ? '✔' : result.needsConfirmation ? '?' : '✖';
  const summary = result.needsConfirmation ? (result.data?.summary as string | undefined) : undefined;
  console.log(`${mark} ${summary ? `${summary} Nada foi alterado ainda.` : result.message}`);
  const channels = result.data?.channels as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(channels) && channels.length && 'level' in channels[0]!) {
    for (const ch of channels) {
      const name = String(ch.name).padEnd(14);
      const mute = ch.muted === null ? '?' : ch.muted ? 'MUTE' : '';
      console.log(`   ${String(ch.channel).padStart(2)}  ${name} ${String(ch.level).padStart(11)}  ${mute}`);
    }
    if (result.data?.master) console.log(`   Master            ${String(result.data.master).padStart(11)}`);
  } else if (
    result.data &&
    !('fromDB' in result.data) &&
    !('undone' in result.data) &&
    !('changes' in result.data) &&
    !('pendingId' in result.data)
  ) {
    console.log(JSON.stringify(result.data, null, 2));
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
  const { loaded, mixer, controller } = await createApp();
  const rl = lineReader();
  console.log(`MixAI console — ${loaded.config.mixer.mode === 'mock' ? 'mesa SIMULADA' : `mesa real em ${loaded.config.mixer.ip}`}`);
  print(await controller.ensureConnected());
  console.log('Digite "ajuda" para ver os comandos.');

  while (true) {
    const line = await rl.question('mixai> ');
    if (line === null) break; // entrada fechada (Ctrl+D)
    const cmd = parseCommand(line, controller.names);
    if (cmd.kind === 'quit') break;
    if (cmd.kind === 'help') {
      console.log(HELP);
      continue;
    }
    if (cmd.kind === 'empty') continue;
    if (cmd.kind === 'error') {
      console.log(cmd.message);
      continue;
    }
    try {
      let result = await runCommand(controller, cmd);
      if (!result) continue;
      print(result);
      if (result.needsConfirmation && result.pendingId) {
        const answer = ((await rl.question('Confirmar? (s/n) ')) ?? '').trim().toLowerCase();
        if (answer === 's' || answer === 'sim') {
          result = await runCommand(controller, cmd, result.pendingId);
          if (result) print(result);
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

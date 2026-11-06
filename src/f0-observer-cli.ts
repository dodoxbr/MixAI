#!/usr/bin/env node
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from './core/config.js';
import { OwnerLock, ownerLockFile } from './core/owner-lock.js';
import { Ui16ReadOnlyObserver, isObserverEthernetIP } from './mixer/readonly-observer.js';
import { exportObserverReport, ScopeSchema, type ObserverScope } from './mixer/observer-report.js';

export const F0C_HELP = `F0C — observador Ui16 SOMENTE LEITURA; execução física manual, nunca pelo smoke/CI.
Uso após confirmar a UI oficial e desconectar PA/HA800/fones:
  npm run observe:f0 -- --physical-readonly --audio-disconnected --ip IP_ETHERNET --confirm-ethernet-ip IP_ETHERNET --channels 1
Opções: --aux 1 (bus confirmado, não comprova saída física), --master,
  --duration 60 (1–900 s), --max-events 500 (8–2000), --report work/f0c-ensaio
--report é opt-in: cria .json e .md exclusivos, nunca sobrescreve. Sem essa opção, só memória/tela.
Terminal interativo obrigatório. Ctrl+C encerra e exporta. Nenhum comando de ajuste é aceito.
Não usar o IP do hotspot como fato. Não altera rede/driver/firewall nem carrega PINs/config local.
Hardware/firmware continuam pendentes de validação. Não executar antes da chegada da mesa.`;

export function parseObserverArgs(args: string[]) {
  const values = new Map<string, string>(); const flags = new Set<string>();
  const valued = ['--ip', '--confirm-ethernet-ip', '--channels', '--aux', '--duration', '--max-events', '--report'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (values.has(arg) || flags.has(arg)) throw new Error('F0C_INVALID_ARGS');
    if (['--physical-readonly', '--audio-disconnected', '--master'].includes(arg)) flags.add(arg);
    else if (valued.includes(arg) && args[i + 1] && !args[i + 1]!.startsWith('--')) values.set(arg, args[++i]!);
    else throw new Error('F0C_INVALID_ARGS');
  }
  const ip = values.get('--ip');
  if (!flags.has('--physical-readonly') || !flags.has('--audio-disconnected') || !ip ||
    !isObserverEthernetIP(ip) || values.get('--confirm-ethernet-ip') !== ip) throw new Error('F0C_EXPLICIT_MANUAL_GATES_REQUIRED');
  const list = (s: string | undefined) => s && /^\d+(,\d+)*$/.test(s) ? s.split(',').map(Number) : [];
  const rawScope: ObserverScope = { channels: list(values.get('--channels')), aux: list(values.get('--aux')), master: flags.has('--master') };
  if (values.has('--aux') && rawScope.aux.length === 0) throw new Error('F0C_INVALID_ARGS');
  const scope = ScopeSchema.safeParse(rawScope);
  const number = (key: string, fallback: number) => values.has(key) && !/^\d+$/.test(values.get(key)!) ? NaN : Number(values.get(key) ?? fallback);
  const duration = number('--duration', 60), maxEvents = number('--max-events', 500);
  if (!scope.success || !Number.isInteger(duration) || duration < 1 || duration > 900 || !Number.isInteger(maxEvents) || maxEvents < 8 || maxEvents > 2000) throw new Error('F0C_INVALID_ARGS');
  return { ip, scope: scope.data, durationMs: duration * 1000, maxEvents, reportPrefix: values.get('--report') };
}

/** IO substituível só para testar o caminho manual com socket falso, sem terminal/equipamento. */
export async function runF0Observer(args: string[], io: {
  interactive: boolean; write: (text: string) => void;
} = { interactive: !!process.stdin.isTTY && !!process.stdout.isTTY, write: (text) => console.log(text) }): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { io.write(F0C_HELP); return 0; }
  let lock: OwnerLock | undefined;
  let observer: Ui16ReadOnlyObserver | undefined;
  const files: Array<{ fd: number; path: string }> = [];
  let filesComplete = false;
  let phase = 'arguments';
  const stop = () => { void observer?.stop('operator'); };
  try {
    const options = parseObserverArgs(args);
    phase = 'terminal';
    if (!io.interactive) throw new Error('F0C_INTERACTIVE_TERMINAL_REQUIRED');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('F0C_NODE22_REQUIRED');
    phase = 'owner_lock';
    lock = new OwnerLock(ownerLockFile('real', '')!, 'observador F0C', { install: PROJECT_ROOT, equipment: 'Ui16 F0C somente leitura' }).acquire();
    phase = 'report_reservation';
    if (options.reportPrefix) {
      // Reserva ambos ANTES de conectar. Nenhum arquivo preexistente é alterado.
      for (const ext of ['json', 'md']) {
        const path = resolve(`${options.reportPrefix}.${ext}`);
        files.push({ path, fd: openSync(path, 'wx', 0o600) });
      }
    }
    phase = 'observer';
    const appVersion = (JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8')) as {version: string}).version;
    observer = new Ui16ReadOnlyObserver({ ip: options.ip, scope: options.scope, appVersion,
      source: 'manual_device_stream', ethernetConfirmed: true, audioDisconnected: true,
      durationMs: options.durationMs, maxEvents: options.maxEvents,
      onEvent: (event) => io.write(JSON.stringify(event)),
    });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    io.write('F0C SOMENTE LEITURA: observar somente alterações feitas pelo operador na UI oficial.');
    let failed = false;
    try { await observer.start(); } catch { failed = true; }
    await observer.done;
    const report = observer.report();
    phase = 'report_export';
    if (files.length) {
      writeFileSync(files[0]!.fd, exportObserverReport(report, 'json'));
      writeFileSync(files[1]!.fd, exportObserverReport(report, 'markdown'));
      filesComplete = true;
    }
    io.write(`F0C encerrado: ${report.stopReason}; eventos=${report.events.length}; hardware pendente.`);
    return failed || !['operator', 'duration'].includes(report.stopReason!) ? 1 : 0;
  } catch {
    // Nenhuma mensagem da biblioteca, IP, caminho, payload ou holder da trava sai aqui.
    io.write(`F0C recusado/falhou na etapa ${phase}. Confira flags, terminal, trava existente e destino novo do relatório; não contorne permissões. Use --help.`);
    return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { await observer?.stop(); }
    finally {
      try {
        for (const file of files) {
          try { closeSync(file.fd); }
          finally { if (!filesComplete) unlinkSync(file.path); }
        }
      } finally { lock?.release(); }
    }
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  runF0Observer(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    console.error('F0C falhou ao encerrar. Nenhum detalhe sensível foi registrado.'); process.exitCode = 1;
  });
}

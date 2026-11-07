#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObserverPrivateIP, queryWindowsObserverRoute, type ObserverTransport } from './mixer/observer-network.js';

export const ROUTE_PREFLIGHT_HELP = `F0E — consulta LOCAL de rota Windows, sem arquivos PowerShell, probes ou conexão à mesa.
npm run preflight:f0 -- --ip IP_CONFIRMADO --transport wifi|ethernet --interface-index INDICE
PowerShell restrito: node dist/f0-route-preflight-cli.js com os mesmos argumentos (evita npm.ps1).
Sem IP/índice padrão. Retorna somente decisão sanitizada; não configura a rede nem substitui a supervisão física.
Não altera ExecutionPolicy. Se cmdlets nativos forem bloqueados, recusa sem fallback.`;

export function runRoutePreflight(args: string[], io = {
  write: (s: string) => console.log(s), query: queryWindowsObserverRoute,
}): number {
  if (args.length === 1 && args[0] === '--help') { io.write(ROUTE_PREFLIGHT_HELP); return 0; }
  try {
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!;
      if (!['--ip', '--transport', '--interface-index'].includes(key) || values.has(key) || !args[i + 1]) throw new Error();
      values.set(key, args[i + 1]!);
    }
    const ip = values.get('--ip') ?? '', transport = values.get('--transport') ?? '', text = values.get('--interface-index') ?? '';
    const index = Number(text);
    if (!isObserverPrivateIP(ip) || !['wifi', 'ethernet'].includes(transport) || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(index) || index > 0xffffffff) throw new Error();
    const decision = io.query(ip, transport as ObserverTransport, index);
    io.write(JSON.stringify(decision));
    return decision.passed ? 0 : 1;
  } catch {
    io.write('F0E_ROUTE_PREFLIGHT_FAILED: confira argumentos e acesso às consultas nativas; não altere políticas para contornar o bloqueio.');
    return 1;
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = runRoutePreflight(process.argv.slice(2));

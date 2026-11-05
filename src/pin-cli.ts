/**
 * Lógica do "npm run pin" (separada para poder testar sem terminal).
 * Grava SÓ o hash (scrypt) em config/secrets.yaml. O PIN nunca é exibido, registrado em log
 * nem passado por argumento.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { parse, stringify } from "yaml";
import { hashPin, PIN_RE, verifyPin } from "./server/pin.js";

export interface PinIO {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
}

export const NOT_INTERACTIVE = [
  'O "npm run pin" precisa de um terminal INTERATIVO: o PIN é digitado sem aparecer na tela',
  'e nunca é aceito por argumento, arquivo ou "pipe" (para não ficar em histórico ou log).',
  "Abra o PowerShell (Windows) ou o Terminal e rode, na pasta do MixAI:",
  "  npm run pin -- operador",
  "  npm run pin -- musico",
  "Nada foi gravado.",
].join("\n");

/** Uma só leitura de linhas para as duas perguntas (o "Repita" não perde a segunda linha). */
function prompter(io: PinIO) {
  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal: true,
  });
  // Não ecoa o que é digitado.
  (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput =
    () => undefined;
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question: string): Promise<string | undefined> {
      io.stdout.write(question);
      const r = await lines.next();
      io.stdout.write("\n");
      return r.done ? undefined : String(r.value).trim(); // undefined = Ctrl+D / fim da entrada
    },
    close: () => rl.close(),
  };
}

/** Devolve o código de saída (0 = gravou). */
export async function pinCommand(args: string[], configDir: string, io: PinIO): Promise<number> {
  const who = (args[0] ?? '').toLowerCase();
  const field = who.startsWith('oper') ? 'operatorPinHash' : who.startsWith('mus') ? 'musicianPinHash' : undefined;
  if (!field) {
    io.stderr.write('Uso: npm run pin -- operador   |   npm run pin -- musico\n');
    return 1;
  }
  if (!io.stdin.isTTY) {
    io.stderr.write(`${NOT_INTERACTIVE}\n`);
    return 2;
  }
  const file = join(configDir, 'secrets.yaml');
  const current = ((existsSync(file) ? parse(readFileSync(file, 'utf8')) : {}) ?? {}) as Record<string, unknown>;
  const p = prompter(io);
  let pin: string | undefined;
  let again: string | undefined;
  try {
    pin = await p.ask(`Novo PIN ${field === 'operatorPinHash' ? 'do OPERADOR' : 'dos MÚSICOS'} (4 a 8 dígitos): `);
    if (pin !== undefined && PIN_RE.test(pin)) again = await p.ask('Repita o PIN: ');
  } finally {
    p.close();
  }
  if (pin === undefined) {
    io.stderr.write('Entrada encerrada antes do PIN. Nada foi gravado.\n');
    return 2;
  }
  if (!PIN_RE.test(pin)) {
    io.stderr.write('PIN inválido: use de 4 a 8 dígitos. Nada foi gravado.\n');
    return 1;
  }
  if (again !== pin) {
    io.stderr.write('Os PINs não conferem. Nada foi gravado.\n');
    return 1;
  }
  const other = field === 'operatorPinHash' ? current.musicianPinHash : current.operatorPinHash;
  if (verifyPin(pin, typeof other === 'string' ? other : undefined)) {
    io.stderr.write('Este PIN já é usado pelo outro perfil. Operador e músicos precisam de PINs diferentes. Nada foi gravado.\n');
    return 1;
  }
  current[field] = hashPin(pin);
  writeFileSync(file, `# Gerado por "npm run pin". Contém só HASHES (scrypt), nunca o PIN. Não publique este arquivo.\n${stringify(current)}`, { mode: 0o600 });
  io.stdout.write(`PIN gravado (só o hash) em ${file}. Reinicie o servidor para valer.\n`);
  return 0;
}

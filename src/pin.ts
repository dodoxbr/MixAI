#!/usr/bin/env node
/**
 * Cadastra o PIN do operador ou dos músicos. Grava SÓ o hash em config/secrets.yaml
 * (arquivo fora do Git). O PIN não é exibido nem registrado.
 *
 *   npm run pin -- operador
 *   npm run pin -- musico
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { parse, stringify } from 'yaml';
import { loadConfig } from './core/config.js';
import { hashPin, PIN_RE, verifyPin } from './server/pin.js';

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
    // Não ecoa o que é digitado.
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    if (stdin.isTTY) out._writeToOutput = () => stdout.write('');
    stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const who = (process.argv[2] ?? '').toLowerCase();
  const field = who.startsWith('oper') ? 'operatorPinHash' : who.startsWith('mus') ? 'musicianPinHash' : undefined;
  if (!field) {
    console.log('Uso: npm run pin -- operador   |   npm run pin -- musico');
    process.exit(1);
  }
  const { configDir } = loadConfig();
  const file = join(configDir, 'secrets.yaml');
  const current = (existsSync(file) ? parse(readFileSync(file, 'utf8')) : {}) ?? {};
  const pin = await ask(`Novo PIN ${field === 'operatorPinHash' ? 'do OPERADOR' : 'dos MÚSICOS'} (4 a 8 dígitos): `);
  if (!PIN_RE.test(pin)) {
    console.log('PIN inválido: use de 4 a 8 dígitos.');
    process.exit(1);
  }
  if ((await ask('Repita o PIN: ')) !== pin) {
    console.log('Os PINs não conferem. Nada foi gravado.');
    process.exit(1);
  }
  const other = field === 'operatorPinHash' ? current.musicianPinHash : current.operatorPinHash;
  if (verifyPin(pin, other)) {
    console.log('Este PIN já é usado pelo outro perfil. Operador e músicos precisam de PINs diferentes.');
    process.exit(1);
  }
  current[field] = hashPin(pin);
  writeFileSync(
    file,
    `# Gerado por "npm run pin". Contém só HASHES (scrypt), nunca o PIN. Não publique este arquivo.\n${stringify(current)}`,
    { mode: 0o600 },
  );
  console.log(`PIN gravado (hash) em ${file}. Reinicie o servidor para valer.`);
}

void main();

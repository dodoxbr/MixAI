#!/usr/bin/env node
/**
 * Cadastra o PIN do operador ou dos músicos. Grava SÓ o hash em config/secrets.yaml
 * (arquivo fora do Git). O PIN não é exibido nem registrado. Precisa de terminal interativo.
 *
 *   npm run pin -- operador
 *   npm run pin -- musico
 */
import { stderr, stdin, stdout } from 'node:process';
import { loadConfig } from './core/config.js';
import { pinCommand } from './pin-cli.js';

pinCommand(process.argv.slice(2), loadConfig().configDir, { stdin, stdout, stderr }).then(
  (code) => process.exit(code),
  (err: Error) => {
    stderr.write(`Erro ao gravar o PIN: ${err.message}\n`);
    process.exit(1);
  },
);

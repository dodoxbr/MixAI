#!/usr/bin/env node
/** Explicit local-file experiment. Does not import the MixAI app/server/config. */
import { speechCommand } from './speech/command.js';
const abort = new AbortController();
const cancel = () => abort.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  process.exitCode = await speechCommand(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, isCI: !!process.env['CI'] }, { signal: abort.signal });
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

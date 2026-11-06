/** Explicit demo: synthetic silence + fake process, never real STT. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speechCommand } from '../../src/speech/command.js';
import { WhisperFileRecognizer } from '../../src/speech/whisper-file.js';
import { fixtureSpawn, silentWav } from './speech-fixtures.js';
const abort = new AbortController();
const cancel = () => abort.abort();
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
const dir = await mkdtemp(join(tmpdir(), 'mixai-stt-demo-'));
try {
  const audio = join(dir, 'synthetic.wav'); const model = join(dir, 'fixture.json');
  await writeFile(audio, silentWav(), { mode: 0o600 });
  await writeFile(model, JSON.stringify({ text: 'Não altere nada.' }), { mode: 0o600 });
  process.exitCode = await speechCommand(['--executable', process.execPath, '--model', model, '--audio', audio, '--authorize-audio', '--local-output', '--case', 'negacao'],
    { stdout: process.stdout, stderr: process.stderr, isCI: !!process.env['CI'] },
    { signal: abort.signal, simulated: true, factory: config => new WhisperFileRecognizer(config, fixtureSpawn) });
} finally {
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  await rm(dir, { recursive: true, force: true });
}

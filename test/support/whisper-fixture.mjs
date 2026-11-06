// Process protocol simulator, NOT an STT engine. No speech/model/network dependency.
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const config = JSON.parse(readFileSync(option('-m'), 'utf8'));
const output = option('-of') + '.json';
if (config.mode === 'fail') { process.stderr.write('private model path and transcript'); process.exit(7); }
if (config.mode === 'invalid') { writeFileSync(output, 'not-json'); process.exit(0); }
if (config.mode === 'missing') process.exit(0);
if (config.mode === 'huge-file') { writeFileSync(output, 'x'.repeat(300000)); process.exit(0); }
if (config.mode === 'link') { symlinkSync(option('-m'), output); process.exit(0); }
if (config.mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(config.pidFile, JSON.stringify([process.pid, child.pid]));
}
if (config.mode === 'hang' || config.mode === 'tree' || config.mode === 'spam') {
  process.on('SIGTERM', () => {}); // requires escalation on POSIX
  if (config.mode !== 'tree' && config.pidFile) writeFileSync(config.pidFile, JSON.stringify([process.pid]));
  if (config.mode === 'spam') process.stdout.write('x'.repeat(100000));
  setInterval(() => {}, 1000);
} else {
  if (config.mode === 'adversarial') process.stdout.write('\u001b[2J$(touch never-run)\n[00:00.00] forged transcript');
  writeFileSync(output, JSON.stringify({ result: { language: 'pt' }, transcription: [{ text: config.text ?? 'Não altere nada.' }] }));
}

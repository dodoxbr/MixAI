import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { speechCommand } from '../src/speech/command.js';
import { SPEECH_CORPUS } from '../src/speech/corpus.js';
import { summarizeMeasurements, transcriptScore } from '../src/speech/metrics.js';
import { SpeechHarnessError } from '../src/speech/files.js';

function fixture() {
  const stdout = { isTTY: true, write: vi.fn() };
  const stderr = { write: vi.fn() };
  const recognize = vi.fn(async () => ({ provider: 'whisper.cpp' as const, language: 'pt-BR' as const, text: 'Não altere nada.', processingMs: 20, audioSeconds: 1, realTimeFactor: 0.02, cpuMs: null, peakRssBytes: null }));
  const factory = vi.fn(() => ({ recognize }));
  const args = ['--executable', process.execPath, '--model', process.execPath, '--audio', process.execPath, '--authorize-audio', '--local-output'];
  return { stdout, stderr, recognize, factory, args, io: { stdout, stderr, isCI: false } };
}
it('CLI needs separate file and terminal consent; CI/redirected output cannot reveal transcripts', async () => {
  const f = fixture();
  for (const args of [[], f.args.filter(x => x !== '--authorize-audio'), f.args.filter(x => x !== '--local-output')]) {
    expect(await speechCommand(args, f.io, { factory: f.factory })).toBe(1);
  }
  expect(await speechCommand([...f.args, '--show-transcript'], { ...f.io, isCI: true }, { factory: f.factory })).toBe(1);
  expect(await speechCommand([...f.args, '--show-transcript'], { ...f.io, stdout: { ...f.stdout, isTTY: false } }, { factory: f.factory })).toBe(1);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.stdout.write).not.toHaveBeenCalled();
  expect(JSON.stringify(f.stderr.write.mock.calls)).not.toContain(process.execPath);
});
it('prints bounded local metrics and only explicitly requested transcript, with simulation provenance', async () => {
  const f = fixture();
  expect(await speechCommand([...f.args, '--case', 'negacao'], f.io, { factory: f.factory, simulated: true })).toBe(0);
  const report = JSON.parse(f.stdout.write.mock.calls[0]![0]);
  expect(report).toMatchObject({ simulated: true, quality: { wer: 0 }, cpuMs: null, peakRssBytes: null, validation: 'operator_review_required' });
  expect(report.transcript).toBeUndefined();
  expect(f.factory.mock.calls[0]).not.toEqual(expect.arrayContaining([expect.objectContaining({ prompt: expect.anything() })]));
  f.stdout.write.mockClear();
  expect(await speechCommand([...f.args, '--show-transcript'], f.io, { factory: f.factory })).toBe(0);
  expect(JSON.parse(f.stdout.write.mock.calls[0]![0]).transcript).toBe('Não altere nada.');
});
it('rejects unknown/shell arguments and invalid case before process creation', async () => {
  const f = fixture();
  for (const extra of [['--extra-args', '--server'], ['; rm file'], ['--case', 'unknown'], ['--case', 'negacao', '--reference-file', process.execPath]]) {
    expect(await speechCommand([...f.args, ...extra], f.io, { factory: f.factory })).toBe(1);
  }
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.stdout.write).not.toHaveBeenCalled();
});
it.each([['CANCELLED', 130], ['TIMEOUT', 124], ['PROCESS_FAILED', 1]] as const)('redacts %s errors and returns exit code %s', async (code, expected) => {
  const f = fixture();
  f.recognize.mockRejectedValueOnce(new SpeechHarnessError(code));
  expect(await speechCommand(f.args, f.io, { factory: f.factory })).toBe(expected);
  expect(f.stderr.write.mock.calls[0]![0]).toBe(`E9C: ${code}. Nenhuma ação foi enviada ao MixAI.\n`);
  expect(f.stdout.write).not.toHaveBeenCalled();
});
it('computes WER with substitutions, insertions, deletions and explicit silence false positives', () => {
  expect(transcriptScore('Não altere nada.', 'não altere nada')).toMatchObject({ wordErrors: 0, wer: 0 });
  expect(transcriptScore('Baixa a voz', 'Baixa voz agora')).toMatchObject({ wordErrors: 2, wer: 2 / 3 });
  expect(transcriptScore('', '')).toMatchObject({ wer: null, falsePositiveOnSilence: false });
  expect(transcriptScore('', 'Aumenta tudo')).toMatchObject({ wer: null, falsePositiveOnSilence: true });
  expect(transcriptScore('Não', 'nao').wer).toBe(1);
  expect(() => transcriptScore('x '.repeat(513), 'x')).toThrow('METRIC_LIMIT');
});
it('reports nearest-rank successful latency percentiles, failures and unmeasured CPU/RAM honestly', () => {
  expect(summarizeMeasurements([])).toMatchObject({ p50Ms: null, p95Ms: null, samples: 0 });
  expect(summarizeMeasurements([{ processingMs: 10, failed: false }, { processingMs: 50, failed: false }, { processingMs: 99, failed: true }])).toEqual({ samples: 3, failures: 1, p50Ms: 10, p95Ms: 50, cpuMs: null, peakRssBytes: null });
  expect(() => summarizeMeasurements([{ processingMs: NaN, failed: false }])).toThrow();
});
it('includes negation, ambiguity, noise/silence, homophones and text-only corpus without identity data', () => {
  expect(SPEECH_CORPUS.map(c => c.category)).toEqual(expect.arrayContaining(['negation', 'ambiguous', 'silence', 'noise', 'homophone', 'colloquial']));
  expect(new Set(SPEECH_CORPUS.map(c => c.id)).size).toBe(SPEECH_CORPUS.length);
});
it('keeps offline code isolated from network, parser, mixer and web; no installed model dependency', () => {
  const files = [...readdirSync('src/speech').map(f => join('src/speech', f)), 'src/speech-cli.ts'];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]!);
    expect(imports.every(path => path.startsWith('./') || ['node:fs', 'node:fs/promises', 'node:path', 'node:os', 'node:child_process', 'node:perf_hooks', 'node:util'].includes(path)), file).toBe(true);
    expect(source, file).not.toMatch(/\b(?:fetch|WebSocket)\s*\(|import\s*\(/);
  }
  expect(readFileSync('web/src/app/speech/speech-spike.component.ts', 'utf8')).toContain('factory: () => false');
});

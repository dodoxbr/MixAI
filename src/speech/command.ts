import { parseArgs } from 'node:util';
import { readLocal, SpeechHarnessError } from './files.js';
import { SPEECH_CORPUS } from './corpus.js';
import { transcriptScore } from './metrics.js';
import { WhisperFileRecognizer, type FileSpeechRecognizer, type WhisperFileConfig } from './whisper-file.js';

export interface SpeechCommandIO {
  stdout: { isTTY?: boolean; write(text: string): unknown };
  stderr: { write(text: string): unknown };
  isCI: boolean;
}
export const SPEECH_HELP = 'Uso local: npm run speech:file -- --executable <caminho-absoluto> --model <caminho-absoluto> --audio <WAV-absoluto> --authorize-audio --local-output [--case <id> | --reference-file <texto-local>] [--timeout-ms 30000] [--threads 2] [--show-transcript]\n';
export async function speechCommand(args: string[], io: SpeechCommandIO, options: {
  signal?: AbortSignal;
  factory?: (config: WhisperFileConfig) => FileSpeechRecognizer;
  simulated?: boolean;
} = {}): Promise<number> {
  try {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      executable: { type: 'string' }, model: { type: 'string' }, audio: { type: 'string' },
      'authorize-audio': { type: 'boolean' }, 'local-output': { type: 'boolean' }, 'show-transcript': { type: 'boolean' },
      case: { type: 'string' }, 'reference-file': { type: 'string' }, 'timeout-ms': { type: 'string' }, threads: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) { io.stderr.write(SPEECH_HELP); return 0; }
    if (!values['authorize-audio']) throw new SpeechHarnessError('NOT_AUTHORIZED');
    // Never emit recordings, paths or transcripts into redirected output/CI logs.
    if (io.isCI || io.stdout.isTTY !== true || !values['local-output']) throw new SpeechHarnessError('NOT_AUTHORIZED');
    if (!values.executable || !values.model || !values.audio || (values.case && values['reference-file'])) throw new SpeechHarnessError('CONFIG');
    let reference: string | undefined;
    if (values.case) {
      const entry = SPEECH_CORPUS.find(entry => entry.id === values.case);
      if (!entry) throw new SpeechHarnessError('CONFIG');
      reference = entry.reference;
    }
    if (values['reference-file']) reference = new TextDecoder('utf-8', { fatal: true }).decode(await readLocal(values['reference-file'], 16_000));
    if (reference !== undefined && reference.length > 16000) throw new SpeechHarnessError('CONFIG');
    const factory = options.factory ?? (config => new WhisperFileRecognizer(config));
    const recognizer = factory({ executable: values.executable, model: values.model, timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']), threads: values.threads === undefined ? undefined : Number(values.threads) });
    const result = await recognizer.recognize({ audioFile: values.audio, authorized: true, signal: options.signal });
    io.stdout.write(JSON.stringify({
      experiment: 'E9C', simulated: options.simulated ?? false, validation: 'operator_review_required',
      provider: result.provider, language: result.language, processingMs: result.processingMs,
      audioSeconds: result.audioSeconds, realTimeFactor: result.realTimeFactor, cpuMs: result.cpuMs, peakRssBytes: result.peakRssBytes,
      quality: reference === undefined ? null : transcriptScore(reference, result.text),
      ...(values['show-transcript'] ? { transcript: result.text } : {}),
    }) + '\n');
    return 0;
  } catch (error) {
    const code = error instanceof SpeechHarnessError ? error.code : 'CONFIG';
    io.stderr.write(`E9C: ${code}. Nenhuma ação foi enviada ao MixAI.\n`);
    return code === 'CANCELLED' ? 130 : code === 'TIMEOUT' ? 124 : 1;
  }
}

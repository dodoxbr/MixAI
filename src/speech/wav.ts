import { SpeechHarnessError } from './files.js';
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 60;

/** Deliberately narrow: RIFF/WAVE PCM s16le, mono, 16 kHz. No conversion or metadata forwarded. */
export function validateWav(input: Buffer): { wav: Buffer; durationSeconds: number } {
  const invalid = () => { throw new SpeechHarnessError('INVALID_AUDIO'); };
  if (input.length < 44 || input.length > MAX_AUDIO_BYTES || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE' || input.readUInt32LE(4) + 8 !== input.length) return invalid();
  let format = false;
  let pcm: Buffer | undefined;
  let offset = 12;
  let chunks = 0;
  while (offset < input.length) {
    if (++chunks > 128 || offset + 8 > input.length) return invalid();
    const id = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size % 2);
    if (next > input.length) return invalid();
    if (id === 'fmt ') {
      if (format || size !== 16 || input.readUInt16LE(start) !== 1 || input.readUInt16LE(start + 2) !== 1 || input.readUInt32LE(start + 4) !== 16000 || input.readUInt32LE(start + 8) !== 32000 || input.readUInt16LE(start + 12) !== 2 || input.readUInt16LE(start + 14) !== 16) return invalid();
      format = true;
    }
    if (id === 'data') {
      if (pcm || !size || size % 2 !== 0 || size > MAX_AUDIO_SECONDS * 32000) return invalid();
      pcm = input.subarray(start, end);
    }
    offset = next;
  }
  if (!format || !pcm) return invalid();
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return { wav, durationSeconds: pcm.length / 32000 };
}

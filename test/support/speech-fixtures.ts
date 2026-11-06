import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProcessSpawner } from '../../src/speech/whisper-file.js';
/** Deliberately substitutes the executable only inside tests/demo. */
export const fixtureSpawn: ProcessSpawner = (_file, args, options) => spawn(process.execPath, [fileURLToPath(new URL('./whisper-fixture.mjs', import.meta.url)), ...args], options);
export function silentWav(seconds = 0.1): Buffer {
  const bytes = Math.floor(seconds * 16000) * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  return wav;
}

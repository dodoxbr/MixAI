import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type SpeechErrorCode = 'CONFIG' | 'NOT_AUTHORIZED' | 'FILE_UNAVAILABLE' | 'INVALID_AUDIO' | 'CANCELLED' | 'TIMEOUT' | 'SPAWN_FAILED' | 'PROCESS_FAILED' | 'OUTPUT_LIMIT' | 'INVALID_OUTPUT' | 'CLEANUP_FAILED';
/** Never attach paths, subprocess output or transcription to errors/logs. */
export class SpeechHarnessError extends Error {
  constructor(readonly code: SpeechErrorCode) { super(code); this.name = 'SpeechHarnessError'; }
}
export function localPath(path: string): void {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\x00-\x1f\x7f]/.test(path)) throw new SpeechHarnessError('CONFIG');
}
export async function regularFile(path: string): Promise<string> {
  localPath(path);
  try {
    if (!(await lstat(path)).isFile()) throw new Error();
    const canonical = await realpath(path);
    localPath(canonical);
    return canonical;
  } catch { throw new SpeechHarnessError('FILE_UNAVAILABLE'); }
}
/** Bounded read via one handle; reject symlinks and non-regular files before allocating. */
export async function readLocal(path: string, limit: number): Promise<Buffer> {
  const file = await regularFile(path);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new SpeechHarnessError('OUTPUT_LIMIT');
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw new SpeechHarnessError('FILE_UNAVAILABLE');
    return buffer.subarray(0, used);
  } catch (error) {
    if (error instanceof SpeechHarnessError) throw error;
    throw new SpeechHarnessError('FILE_UNAVAILABLE');
  } finally { await handle?.close(); }
}

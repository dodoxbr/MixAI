import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DocumentSchema, ReferenceError, type Document } from './schema.js';
const MAX_BYTES = 16 * 1024 * 1024;
/** Single owner process (existing LAB OwnerLock). Fresh read + CAS + synchronous atomic rename.
 * Corruption fails closed; backup is for explicit recovery, never a silent rewind of decisions. */
export class ReferenceStore {
  constructor(readonly file: string) {}
  read(): Document {
    try {
      if (!existsSync(this.file)) return { schemaVersion: 1, revision: 0, references: [], requests: [] };
      if (statSync(this.file).size > MAX_BYTES) throw new Error();
      return DocumentSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch { throw new ReferenceError('STORE_UNAVAILABLE'); }
  }
  commit(document: Document, expected: number): void {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      if (this.read().revision !== expected) throw new ReferenceError('CONFLICT');
      const next = DocumentSchema.parse({ ...document, revision: expected + 1 });
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new ReferenceError('CAPACITY');
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
      writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 }); renameSync(tmp, this.file);
    } catch (error) {
      if (error instanceof ReferenceError) throw error;
      throw new ReferenceError('STORE_UNAVAILABLE');
    } finally { rmSync(tmp, { force: true }); }
  }
}

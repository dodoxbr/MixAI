import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Principal } from './auth.js';

export const musicianRoster = [
  { id: 'fred', name: 'Fred', channels: [3] },
  { id: 'lucius', name: 'Lucius', channels: [1, 4] },
  { id: 'leandro', name: 'Leandro', channels: [5] },
  { id: 'fernando', name: 'Fernando', channels: [6] },
  { id: 'laviquinho', name: 'Laviquinho', channels: [7] },
] as const;
const bindingSchema = z.object({ schemaVersion: z.literal(1), sessionId: z.string().regex(/^[a-f0-9]{16}$/), musicianId: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1).max(60), channels: z.array(z.number().int().min(1).max(12)).min(1).max(12), mute: z.boolean(), revision: z.number().int().positive() }).strict();
export type MusicianBinding = z.infer<typeof bindingSchema>;
/** Identity is server owned. Persisted bindings never recreate authenticated sessions. */
export class MusicianAccess {
  private bindings = new Map<string, MusicianBinding>();
  private sessions = new Set<string>();
  private revision = 0;
  constructor(private file?: string) {
    if (file) {
      try {
        const saved = z.object({ schemaVersion: z.literal(1), bindings: z.array(bindingSchema).max(1000) }).strict().parse(JSON.parse(readFileSync(file, 'utf8')));
        for (const binding of saved.bindings) { this.bindings.set(binding.sessionId, binding); this.revision = Math.max(this.revision, binding.revision); }
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Arquivo de vínculos inválido; inicialização recusada.'); }
    }
  }
  observe(p: Principal) { if (p.role === 'musician') this.sessions.add(p.id); }
  get(p: Principal): MusicianBinding | undefined { return p.role === 'musician' ? this.bindings.get(p.id) : undefined; }
  list() { return [...new Set([...this.sessions, ...this.bindings.keys()])].map(sessionId => ({ sessionId, observed: this.sessions.has(sessionId), binding: this.bindings.get(sessionId) ?? null })); }
  bind(input: unknown, configured: number[]) {
    const binding = bindingSchema.parse({ ...(input as object), schemaVersion: 1, revision: ++this.revision });
    if (!this.sessions.has(binding.sessionId)) throw new Error('Sessão de músico não observada neste servidor.');
    if (new Set(binding.channels).size !== binding.channels.length || binding.channels.some(ch => !configured.includes(ch))) throw new Error('Canais inválidos ou não configurados.');
    const previous = this.bindings.get(binding.sessionId);
    this.bindings.set(binding.sessionId, binding);
    try { this.save(); } catch (err) { if (previous) this.bindings.set(binding.sessionId, previous); else this.bindings.delete(binding.sessionId); throw err; }
    return binding;
  }
  revoke(id: string) { this.bindings.delete(id); this.save(); }
  end(id: string) { this.sessions.delete(id); this.revoke(id); }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, bindings: [...this.bindings.values()] }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

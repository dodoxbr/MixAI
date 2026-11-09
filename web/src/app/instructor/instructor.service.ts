import { Injectable, InjectionToken, computed, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { adaptInstructionCatalog, type InstructionCatalog } from './instructor-contract';
import { InstructorLibraryError, LIBRARY_MESSAGES, loadInstructorLibrary } from './instructor-library';

/**
 * Catalog loader boundary. The default consumes the REAL technical library through GET /api/instructor/procedures
 * (read-only, operator and musician). Fixtures exist only for tests/development, injected explicitly via this token.
 */
export const INSTRUCTOR_CATALOG = new InjectionToken<() => Promise<unknown>>('UI16_INSTRUCTOR_CATALOG', { providedIn: 'root', factory: () => { const session = inject(SessionService); return () => loadInstructorLibrary(() => session.token()); } });
@Injectable({ providedIn: 'root' })
export class InstructorService {
  private readonly session = inject(SessionService);
  private readonly live = inject(LiveService);
  private readonly loader = inject(INSTRUCTOR_CATALOG);
  readonly available = computed(() => !!this.session.token() && this.live.hello()?.mode === 'lab' && ['operator','musician'].includes(this.live.hello()?.role ?? ''));
  readonly connected = computed(() => this.live.connection() === 'online');
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly catalog = signal<InstructionCatalog | null>(null);
  readonly selected = signal<string | null>(null);
  readonly index = signal(0);
  readonly missing = signal(false);
  readonly complete = signal(false);
  readonly procedure = computed(() => this.catalog()?.procedures.find(p => p.id === this.selected()));
  readonly step = computed(() => this.procedure()?.steps[this.index()]);
  private generation = 0;
  private sessionKey = '';
  constructor() {
    effect(() => {
      const key = this.identity();
      if (key !== this.sessionKey) { this.sessionKey = key; this.reset(); }
    });
  }
  private identity() { const h = this.live.hello(); return JSON.stringify([this.session.token(), h?.mode, h?.role, h?.serverId]); }
  private reset() { this.generation++; this.open.set(false); this.loading.set(false); this.error.set(''); this.catalog.set(null); this.selected.set(null); this.index.set(0); this.missing.set(false); this.complete.set(false); }
  async show() { if (!this.available()) return; this.open.set(true); if (!this.catalog()) await this.load(); }
  async load() {
    if (!this.available() || this.loading()) return;
    const generation = ++this.generation; const identity = this.identity(); this.loading.set(true); this.error.set('');
    let stage: 'load' | 'adapt' = 'load';
    try {
      const value = await this.loader();
      stage = 'adapt';
      if (generation === this.generation && identity === this.identity() && this.available()) this.catalog.set(adaptInstructionCatalog(value));
    }
    catch (e) {
      const code = e instanceof InstructorLibraryError ? e.code : stage === 'load' ? 'unavailable' : 'incompatible';
      if (generation === this.generation) this.error.set(LIBRARY_MESSAGES[code]);
      // Sessão vencida/revogada: o mesmo caminho das demais telas (volta ao login), sem repetir a chamada.
      if (code === 'session' && generation === this.generation) this.session.expire('Sua sessão terminou. Entre novamente.');
    }
    finally { if (generation === this.generation) this.loading.set(false); }
  }
  choose(id: string) { if (!this.available() || !this.catalog()?.procedures.some(p => p.id === id)) return; this.selected.set(id); this.index.set(0); this.missing.set(false); this.complete.set(false); }
  next() { if (!this.available() || this.missing() || this.complete()) return; const p = this.procedure(); if (p && this.index() < p.steps.length - 1) this.index.update(i => i + 1); }
  back() { if (!this.available()) return; if (this.complete()) this.complete.set(false); else if (this.index() > 0) this.index.update(i => i - 1); this.missing.set(false); }
  notFound() { if (this.available() && this.step()) this.missing.set(true); }
  found() { if (this.available()) this.missing.set(false); }
  finish() { const p = this.procedure(); if (this.available() && p && !this.missing() && this.index() === p.steps.length - 1) this.complete.set(true); }
  restart() { if (!this.available()) return; this.index.set(0); this.missing.set(false); this.complete.set(false); }
  tasks() { this.selected.set(null); this.index.set(0); this.missing.set(false); this.complete.set(false); }
}

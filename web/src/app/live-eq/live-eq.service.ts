import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { aged, parseProcessing, unknownReading, type ProcessingView } from './processing-view';
/** Component-scoped, read-only poller. Context changes abort and fence in-flight responses. */
@Injectable()
export class LiveEqService {
  readonly live = inject(LiveService);
  private readonly session = inject(SessionService);
  readonly channel = signal<number | null>(null);
  readonly view = signal<ProcessingView | null>(null);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly elapsed = signal(0);
  private received = 0;
  readonly eligible = computed(
    () =>
      this.live.hello()?.mode === 'real' &&
      this.session.role() === 'operator' &&
      this.live.connection() === 'online' &&
      !!this.session.token(),
  );
  constructor() {
    effect((onCleanup) => {
      const channel = this.channel(),
        hello = this.live.hello(),
        token = this.session.token(),
        eligible = this.eligible();
      this.view.set(null);
      this.error.set('');
      this.loading.set(false);
      this.elapsed.set(0);
      if (!eligible || !channel || !hello || !token) return;
      let disposed = false,
        busy = false;
      let controller: AbortController | undefined;
      const poll = async () => {
        if (busy || disposed) return;
        busy = true;
        const started = performance.now();
        controller = new AbortController();
        this.loading.set(true);
        const timeout = setTimeout(() => controller?.abort(), 6000);
        try {
          const response = await fetch(`/api/ui16/processing/${channel}`, {
            headers: { authorization: `Bearer ${token}` },
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal,
          });
          if (!response.ok)
            throw Error(
              response.status === 401 || response.status === 403
                ? 'Sessão sem autorização para leitura.'
                : `Leitura indisponível (HTTP ${response.status}).`,
            );
          const view = parseProcessing(await response.json(), channel, hello.serverId);
          if (!disposed) {
            this.received = started;
            // Conservatively include request transit; delayed HTTP cannot renew evidence.
            this.elapsed.set(performance.now() - started);
            this.view.set(view);
            this.error.set('');
          }
        } catch (e) {
          if (!disposed) {
            this.view.set(null);
            this.error.set(
              controller.signal.aborted
                ? 'Leitura demorou; aguardando nova consulta.'
                : e instanceof Error
                  ? e.message
                  : 'Falha de comunicação.',
            );
          }
        } finally {
          clearTimeout(timeout);
          busy = false;
          if (!disposed) this.loading.set(false);
        }
      };
      void poll();
      const interval = setInterval(() => void poll(), 2000);
      const age = setInterval(() => {
        if (this.view()) this.elapsed.set(performance.now() - this.received);
      }, 500);
      onCleanup(() => {
        disposed = true;
        controller?.abort();
        clearInterval(interval);
        clearInterval(age);
      });
    });
    inject(DestroyRef).onDestroy(() => this.view.set(null));
  }
  reading(suffix: string) {
    return aged(
      this.view()?.parameters[`ch.${this.channel()}.eq.${suffix}`] ?? unknownReading(),
      this.elapsed(),
    );
  }
}

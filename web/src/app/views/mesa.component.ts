import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ActionsService } from '../core/actions.service';
import { LiveService } from '../core/live.service';
import { keys, type StateValue } from '../core/protocol';
import type { FaderMove } from '../ui/fader.component';
import { PendingCardsComponent } from '../ui/pending-cards.component';
import { StatusBarComponent } from '../ui/status-bar.component';
import { StripComponent } from '../ui/strip.component';
import { ToastsComponent } from '../ui/toasts.component';
import { FonesListComponent } from './fones-list.component';
import { AssistantInputComponent } from '../assistant/assistant-input.component';
import { AssistantPanelComponent } from '../assistant/assistant-panel.component';
import { AssistantUiService } from '../core/assistant.service';
import { ScenesComponent } from '../scenes/scenes.component';
import { ScenesUiService } from '../scenes/scenes.service';

interface LogEntry {
  time: string;
  action: string;
  ok: boolean;
  message: string;
  /** "by" = perfil + sessão de quem fez (o PIN do músico é compartilhado: não é uma pessoa). */
  details?: { by?: string };
}

const UNKNOWN: StateValue = { status: 'unknown' };

/** Mesa do operador: faders do PA ou do AUX dos fones, master separado, cartões e histórico. */
@Component({
  selector: 'mx-mesa',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusBarComponent, StripComponent, PendingCardsComponent, ToastsComponent, FonesListComponent, AssistantInputComponent, AssistantPanelComponent, ScenesComponent],
  host: { class: 'mx-view mx-mesa' },
  template: `
    <mx-status-bar />
    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="Mix">
        <button type="button" role="tab" [attr.aria-selected]="bus() === 'pa'" [class.on]="bus() === 'pa'" (click)="bus.set('pa')">PA</button>
        <button type="button" role="tab" [attr.aria-selected]="bus() === 'fones'" [class.on]="bus() === 'fones'" (click)="bus.set('fones')">FONES</button>
      </div>
      @if (bus() === 'fones') {
        <span class="shared-warning">{{ auxName() }}: muda o fone de TODOS</span>
      } @else if (simulatedMeters()) {
        <span class="sim-legend">Medidores SIMULADOS (laboratório) — não é o som real</span>
      }
      <span class="spacer"></span>
      <mx-assistant-input />
      <button type="button" class="btn" [class.on]="assistant.open()" (click)="assistant.open.set(!assistant.open())" [attr.aria-expanded]="assistant.open()">Assistente</button>
      <button type="button" class="btn" [disabled]="!live.writable() || actions.isBusy('undo')" (click)="undo()">Desfazer</button>
      <button type="button" class="btn" [class.on]="showHistory()" (click)="toggleHistory()">Histórico</button>
      <button type="button" class="btn" [class.on]="scenes.open()" (click)="scenes.show()" [attr.aria-expanded]="scenes.open()">Cenas</button>
    </div>

    @if (!live.writable()) {
      <div class="offline-banner" role="alert">{{ offlineText() }}</div>
    }

    <div class="mesa-main">
      @if (bus() === 'fones' && narrow()) {
        <mx-fones-list />
      } @else {
        <div class="strips" #stripRow [class.is-fones]="bus() === 'fones'" (scroll)="rememberScroll()">
          @for (s of strips(); track s.number) {
            <mx-strip
              [name]="s.name"
              [number]="s.number"
              [where]="bus() === 'pa' ? 'no PA' : 'nos fones'"
              [level]="s.level"
              [mute]="s.mute"
              [meter]="s.meter"
              [simulated]="simulatedMeters()"
              [showMeter]="bus() === 'pa'"
              [disabled]="!live.writable()"
              [busy]="actions.isBusy('mute:' + bus() + ':' + s.number)"
              (moved)="fader(s.number, $event)"
              (toggleMute)="toggleMute(s.number, s.mute)"
            />
          }
        </div>
        @if (bus() === 'pa') {
          <div class="master-area">
            <mx-strip
              name="MASTER"
              [master]="true"
              [level]="masterLevel()"
              [meter]="masterMeter()"
              [simulated]="simulatedMeters()"
              [disabled]="!live.writable() || actions.isBusy('master')"
              (moved)="master($event)"
            />
          </div>
        }
      }
      @if (live.pending().length || showHistory() || assistant.open()) {
        <aside class="side" [class.has-assistant]="assistant.open()">
          <mx-pending-cards
            [cards]="live.pending()"
            [canDecide]="true"
            [busy]="actions.deciding()"
            (approve)="actions.decide($event, true)"
            (reject)="actions.decide($event, false)"
          />
          @if (assistant.open()) {
            <mx-assistant-panel />
          }
          @if (showHistory()) {
            <section class="history" aria-label="Histórico">
              <h2>Histórico</h2>
              <ol>
                @for (e of history(); track $index) {
                  <li [class.is-error]="!e.ok">
                    <time>{{ e.time.slice(11, 19) }}</time> {{ e.message }}
                    @if (e.details?.by; as by) {
                      <small class="history-by">— {{ by }}</small>
                    }
                  </li>
                } @empty {
                  <li>Nada ainda.</li>
                }
              </ol>
            </section>
          }
        </aside>
      }
    </div>
    @if (scenes.open()) {
      <mx-scenes />
    }
    <mx-toasts />
  `,
})
export class MesaComponent {
  readonly live = inject(LiveService);
  readonly actions = inject(ActionsService);
  readonly assistant = inject(AssistantUiService);
  readonly scenes = inject(ScenesUiService);

  readonly bus = signal<'pa' | 'fones'>('pa');
  readonly showHistory = signal(false);
  readonly history = signal<LogEntry[]>([]);
  readonly narrow = signal(false);

  readonly aux = computed(() => this.live.hello()?.musicianAux ?? 1);
  readonly auxName = computed(() => this.live.auxes().find((a) => a.number === this.aux())?.name ?? `AUX ${this.aux()}`);
  readonly simulatedMeters = computed(() => !!this.live.meters()?.simulated);
  readonly strips = computed(() => {
    const params = this.live.state()?.params ?? {};
    const aux = this.bus() === 'fones' ? this.aux() : undefined;
    const levels = this.live.meters()?.levels ?? {};
    return this.live.channels().map((ch) => ({
      number: ch.number,
      name: ch.name,
      level: params[keys.level(ch.number, aux)]?.value ?? UNKNOWN,
      mute: params[keys.mute(ch.number, aux)]?.value ?? UNKNOWN,
      meter: levels[`ch.${ch.number}`] ?? null,
    }));
  });
  readonly masterLevel = computed(() => this.live.state()?.params[keys.master]?.value ?? UNKNOWN);
  readonly masterMeter = computed(() => this.live.meters()?.levels['master'] ?? null);
  readonly offlineText = computed(() => {
    const c = this.live.connection();
    if (c !== 'online') return 'Sem conexão com o servidor do MixAI. Reconectando… Os controles voltam sozinhos.';
    const link = this.live.state()?.link;
    if (link === 'DEGRADED_READ_ONLY') return 'Mesa em SOMENTE LEITURA: os valores aparecem, mas nada pode ser alterado agora.';
    return 'A mesa não está pronta para comandos. Os controles voltam quando ela estiver.';
  });

  private readonly stripsEl = viewChild<ElementRef<HTMLElement>>('stripRow');
  /** Primeiro canal visível na rolagem horizontal (para manter ao girar a tela). */
  private firstVisible = 0;
  private restoring = false;

  /** Guarda qual canal está à esquerda. Só leitura de layout: nada é enviado ao servidor. */
  rememberScroll(): void {
    if (this.restoring) return;
    const el = this.stripsEl()?.nativeElement;
    if (!el) return;
    const kids = [...el.children] as HTMLElement[];
    const i = kids.findIndex((k) => k.offsetLeft + k.offsetWidth / 2 >= el.scrollLeft);
    this.firstVisible = Math.max(0, i);
  }

  constructor() {
    // Girar a tela muda o tamanho da área dos canais: volta a mostrar o mesmo canal à esquerda.
    effect((onCleanup) => {
      const el = this.stripsEl()?.nativeElement;
      if (!el || typeof ResizeObserver !== 'function') return;
      let last = el.clientWidth;
      const ro = new ResizeObserver(() => {
        if (el.clientWidth === last) return;
        last = el.clientWidth;
        const target = el.children[this.firstVisible] as HTMLElement | undefined;
        if (!target) return;
        this.restoring = true;
        el.scrollLeft = Math.max(0, target.offsetLeft - el.offsetLeft);
        requestAnimationFrame(() => (this.restoring = false));
      });
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    });
    const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px)') : null;
    if (mq) {
      this.narrow.set(mq.matches);
      const onChange = (e: MediaQueryListEvent) => this.narrow.set(e.matches);
      mq.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => mq.removeEventListener?.('change', onChange));
    }
  }

  fader(channel: number, e: FaderMove): void {
    const aux = this.bus() === 'fones' ? this.aux() : undefined;
    this.actions.fader(`${this.bus()}:${channel}`, channel, aux, e.db, e.final);
  }

  toggleMute(channel: number, mute: StateValue): void {
    if (mute.status !== 'known') return;
    const aux = this.bus() === 'fones' ? this.aux() : undefined;
    void this.actions.run(`mute:${this.bus()}:${channel}`, { type: 'set_mute', channels: [channel], muted: mute.value !== true, aux });
  }

  /** Master: arrastar só escolhe o valor; ao soltar vira pedido com cartão de aprovação. */
  master(e: FaderMove): void {
    if (!e.final) return;
    void this.actions.run('master', { type: 'set_master', db: Number.isFinite(e.db) ? e.db : -100 });
  }

  async undo(): Promise<void> {
    await this.actions.run('undo', { type: 'undo' }, (r) => r.message);
    if (this.showHistory()) await this.loadHistory();
  }

  async toggleHistory(): Promise<void> {
    this.showHistory.update((v) => !v);
    if (this.showHistory()) await this.loadHistory();
  }

  private async loadHistory() {
    const r = await this.live.command({ type: 'history', limit: 30 });
    if (r.ok) this.history.set([...((r.data?.['entries'] as LogEntry[]) ?? [])].reverse());
  }
}

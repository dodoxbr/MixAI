import { LiveChannelComponent } from '../live-ux/live-channel.component';
import { SessionService } from '../core/session.service';
import { SoundcheckComponent } from '../soundcheck/soundcheck.component';
import { ReferenceWorkspaceComponent } from '../reference/reference.component';
import { MusiciansComponent } from '../musicians/musicians.component';
import { EqComponent } from '../eq/eq.component';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
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
  imports: [LiveChannelComponent, SoundcheckComponent, ReferenceWorkspaceComponent, MusiciansComponent, EqComponent, StatusBarComponent, StripComponent, PendingCardsComponent, ToastsComponent, FonesListComponent, AssistantInputComponent, AssistantPanelComponent, ScenesComponent],
  host: { class: 'mx-view mx-mesa', '[class.is-passagem]': 'onPassagem()', '[class.has-selection]': 'selectedChannel() !== null' },
  styles: [`@media (max-width:720px) { :host.has-selection .mesa-main { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'side side' 'strips master'; } :host.has-selection .side { grid-area:side; } :host.has-selection .strips, :host.has-selection mx-fones-list { grid-area:strips; } :host.has-selection .master-area { grid-area:master; } }`],
  template: `
    <mx-status-bar>
      <!-- Navegação principal: destinos (telas). As ferramentas ficam à direita; Sair por último. -->
      <nav status-nav class="main-nav" aria-label="Seções do MixAI">
        <button type="button" class="nav-tab" [class.on]="!onPassagem()" [attr.aria-current]="!onPassagem() ? 'page' : null" (click)="go('mesa')">Mesa</button>
        @if (soundcheckEligible()) {
          <button type="button" class="nav-tab" [class.on]="onPassagem()" [attr.aria-current]="onPassagem() ? 'page' : null" (click)="go('passagem')">Passagem de som</button>
        }
      </nav>
      @if (live.hello()?.mode === 'lab' && live.hello()?.role === 'operator') {
        <ng-container status-action>
        <button status-action type="button" class="btn" (click)="showEq.set(true)" [attr.aria-expanded]="showEq()">EQ LAB</button>
        <button status-action type="button" class="btn" (click)="showMusicians.set(true)">Vincular músicos</button>
        </ng-container>
      }
    </mx-status-bar>
    @if (showMusicians()) { <mx-musicians (closed)="showMusicians.set(false)" /> }
    @if (onPassagem()) {
      <main class="screen-passagem" aria-label="Passagem de som">
        @if (!live.writable()) {
          <div class="offline-banner" role="alert">{{ offlineText() }}</div>
        }
        @if (live.pending().length) {
          <div class="pending-banner" role="status">
            <span>{{ live.pending().length === 1 ? '1 aprovação pendente' : live.pending().length + ' aprovações pendentes' }} na Mesa.</span>
            <button type="button" class="btn" (click)="go('mesa')">Ir para a Mesa</button>
          </div>
        }
        @defer (on immediate) { <mx-soundcheck /> } @placeholder { <p role="status" class="screen-loading">Abrindo a passagem de som…</p> }
      </main>
      <mx-reference-workspace />
    } @else {
    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="Mix">
        <button type="button" role="tab" [attr.aria-selected]="bus() === 'pa'" [class.on]="bus() === 'pa'" (click)="bus.set('pa')">PA</button>
        <button type="button" role="tab" [attr.aria-selected]="bus() === 'fones'" [class.on]="bus() === 'fones'" (click)="bus.set('fones')">{{ auxOverride() === null ? 'FONES' : 'AUX ' + aux() }}</button>
      </div>
      @if (bus() === 'fones') {
        <span class="shared-warning">{{ auxName() }}: {{ aux() === 1 ? 'muda o fone de TODOS (HA800)' : 'AUX ' + aux() + ' · roteamento físico não verificado' }}</span>
      } @else if (simulatedMeters()) {
        <span class="sim-legend"><span class="tb-full">Medidores SIMULADOS (laboratório) — não é o som real</span><span class="tb-short">Medidores SIMULADOS — não é o som real</span></span>
      }
      <span class="spacer"></span>
      <mx-assistant-input />
      <!-- Ações: no celular em retrato viram 4 botões compactos (ícone + rótulo curto) numa linha.
           O nome acessível é sempre o completo. Fora do retrato o grupo é transparente (display: contents). -->
      <div class="toolbar-actions" role="group" aria-label="Ações da mesa">
        <button type="button" class="btn tb-action" aria-label="Assistente" [class.on]="assistant.open()" (click)="assistant.open.set(!assistant.open())" [attr.aria-expanded]="assistant.open()">
          <svg class="tb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
          <span class="tb-full">Assistente</span><span class="tb-short" aria-hidden="true">Chat</span>
        </button>
        <button type="button" class="btn tb-action" aria-label="Desfazer" [disabled]="!live.writable() || actions.isBusy('undo')" (click)="undo()">
          <svg class="tb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5" /><path d="M4 12h10a6 6 0 0 1 0 12h-2" transform="translate(0 -6)" /></svg>
          <span class="tb-full">Desfazer</span><span class="tb-short" aria-hidden="true">Desfazer</span>
        </button>
        <button type="button" class="btn tb-action" aria-label="Histórico" [class.on]="showHistory()" (click)="toggleHistory()" [attr.aria-expanded]="showHistory()">
          <svg class="tb-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
          <span class="tb-full">Histórico</span><span class="tb-short" aria-hidden="true">Histórico</span>
        </button>
        <button type="button" class="btn tb-action" aria-label="Cenas" [class.on]="scenes.open()" (click)="scenes.show()" [attr.aria-expanded]="scenes.open()">
          <svg class="tb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 8 4-8 4-8-4z" /><path d="m4 12 8 4 8-4" /><path d="m4 16 8 4 8-4" /></svg>
          <span class="tb-full">Cenas</span><span class="tb-short" aria-hidden="true">Cenas</span>
        </button>
      </div>
    </div>

    @if (!live.writable()) {
      <div class="offline-banner" role="alert">{{ offlineText() }}</div>
    }

    <mx-reference-workspace />
    <div class="mesa-main">
      @if (bus() === 'fones' && narrow()) {
        <mx-fones-list [auxOverride]="aux()" />
      } @else {
        <div class="strips" #stripRow [class.is-fones]="bus() === 'fones'" (scroll)="rememberScroll()">
          @for (s of strips(); track s.number) {
            <mx-strip
              [name]="s.name"
              [selectable]="true" [selected]="selectedChannel() === s.number" (chosen)="selectedChannel.set(s.number)"
              [number]="s.number"
              [where]="bus() === 'pa' ? 'no PA' : 'no AUX ' + aux()"
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
      @if (selectedChannel() !== null || live.pending().length || showHistory() || assistant.open()) {
        <aside class="side" [class.has-assistant]="assistant.open()">
          @if (selectedChannel(); as channel) {
            <mx-live-channel [channel]="channel" [aux]="bus() === 'fones' ? aux() : undefined"
              (closed)="selectedChannel.set(null)" (channelChanged)="selectChannel($event)" (routeChanged)="selectRoute($event)"
              (historyRequested)="openHistory()" (undoRequested)="undo()" />
          }
          <mx-pending-cards
            [cards]="live.pending()"
            [canDecide]="live.writable()"
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
              <button type="button" class="btn" [disabled]="historyBusy() || live.connection() !== 'online'" (click)="openHistory()">Atualizar histórico</button>
              @if (historyBusy()) { <p role="status">Consultando histórico…</p> }
              @if (historyError()) { <p role="alert">{{ historyError() }}</p> }
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
    }
    @if (scenes.open()) {
      <mx-scenes />
    }
    @if (showEq()) { <mx-eq (closed)="showEq.set(false)" /> }
    <mx-toasts />
  `,
})
export class MesaComponent {
  readonly selectedChannel = signal<number | null>(null);
  readonly auxOverride = signal<number | null>(null);
  private readonly session = inject(SessionService);
  readonly showMusicians = signal(false);
  readonly live = inject(LiveService);
  readonly actions = inject(ActionsService);
  readonly assistant = inject(AssistantUiService);
  readonly scenes = inject(ScenesUiService);

  /** Telas do operador: a Mesa (faders) e a Passagem de som (tela própria, sem competir por altura com os faders). */
  readonly screen = signal<'mesa' | 'passagem'>('mesa');
  readonly soundcheckEligible = computed(() => this.live.hello()?.mode === 'lab' && this.live.hello()?.role === 'operator');
  readonly onPassagem = computed(() => this.screen() === 'passagem' && this.soundcheckEligible());
  go(screen: 'mesa' | 'passagem'): void { this.screen.set(screen); }

  readonly showEq = signal(false);
  readonly bus = signal<'pa' | 'fones'>('pa');
  readonly showHistory = signal(false);
  readonly history = signal<LogEntry[]>([]);
  readonly historyBusy = signal(false);
  readonly historyError = signal('');
  private historyGeneration = 0;
  readonly narrow = signal(false);

  readonly aux = computed(() => this.auxOverride() ?? this.live.hello()?.musicianAux ?? 1);
  readonly auxName = computed(() => this.live.auxes().find((a) => a.number === this.aux())?.name ?? `AUX ${this.aux()}`);
  readonly simulatedMeters = computed(() => !!this.live.meters()?.simulated);
  readonly strips = computed(() => {
    const params = this.live.connection() === 'online' && !this.live.synchronizing() && this.live.state()?.available ? this.live.state()!.params : {};
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
  readonly masterLevel = computed(() => this.live.connection() === 'online' && !this.live.synchronizing() && this.live.state()?.available ? this.live.state()?.params[keys.master]?.value ?? UNKNOWN : UNKNOWN);
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
    effect(() => { this.session.token(); this.live.hello()?.serverId; this.live.hello()?.mode; untracked(() => { this.selectedChannel.set(null); this.historyGeneration++; this.history.set([]); this.historyBusy.set(false); this.historyError.set(''); this.auxOverride.set(null); }); });
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

  selectChannel(channel: number) { if (this.live.channels().some(c => c.number === channel)) this.selectedChannel.set(channel); }
  selectRoute(route: string) {
    if (route === 'pa') { this.bus.set('pa'); return; }
    const aux = Number(route);
    if (!this.live.auxes().some(a => a.number === aux)) return;
    if (this.live.hello()?.mode === 'real' && aux !== this.live.hello()?.musicianAux) return;
    this.auxOverride.set(aux); this.bus.set('fones');
  }
  async openHistory() { this.showHistory.set(true); await this.loadHistory(); }

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
    if (this.historyBusy()) return;
    const generation = ++this.historyGeneration, token = this.session.token(), serverId = this.live.hello()?.serverId;
    this.historyBusy.set(true); this.historyError.set('');
    try {
      const r = await this.live.command({ type: 'history', limit: 30 });
      if (generation !== this.historyGeneration || token !== this.session.token() || serverId !== this.live.hello()?.serverId) return;
      if (r.ok && Array.isArray(r.data?.['entries'])) this.history.set([...(r.data!['entries'] as LogEntry[])].reverse());
      else this.historyError.set('Histórico não disponível. Nenhum pedido será repetido automaticamente.');
    } finally { if (generation === this.historyGeneration) this.historyBusy.set(false); }
  }
}

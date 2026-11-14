import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { LiveEqService } from './live-eq.service';
import { bandCurve, qualityLabel, type Reading } from './processing-view';
@Component({
  selector: 'mx-live-eq',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [LiveEqService],
  host: {
    '[attr.role]': "embedded() ? 'region' : 'dialog'",
    '[attr.aria-modal]': "embedded() ? null : 'true'",
    'aria-label': 'EQ e HPF REAL — somente leitura',
    '[class.embedded]': 'embedded()',
    '(keydown.escape)': 'escape()',
    '(keydown.tab)': 'trap($event)',
  },
  template: ` <section class="panel">
    <header>
      <div>
        <small>REAL · SOMENTE LEITURA</small>
        <h2 tabindex="-1">EQ / HPF · CH{{ channel() }} — {{ name() }}</h2>
      </div>
      @if (!embedded()) { <button class="btn" (click)="closed.emit()">Fechar EQ/HPF</button> }
      @else { <span class="bypass-lamp" data-testid="eq-bypass-lamp" [class.on]="bypass() === 'Sim'" [class.unknown]="bypass() === 'Desconhecido'">BYPASS · {{ bypass() === 'Sim' ? 'ligado' : bypass() === 'Não' ? 'desligado' : 'desconhecido' }}</span> }
    </header>
    @if (!embedded()) {
    <label
      >Canal observado
      <select
        aria-label="Canal do EQ REAL"
        [value]="channel()"
        (change)="channelChanged.emit(+$any($event.target).value)"
      >
        @for (ch of service.live.channels(); track ch.number) {
          <option [value]="ch.number" [selected]="ch.number === channel()">
            CH{{ ch.number }} — {{ ch.name }}
          </option>
        }
      </select></label
    >
    }
    <p>
      Processamento da entrada, comum aos destinos. Não é EQ exclusivo do PA ou AUX. AUX1/HA800 é
      compartilhado.
    </p>
    <p class="notice">
      Controles bloqueados nesta tela. Nenhuma alteração é enviada. Ajustes futuros exigem proposta
      e confirmação no servidor.
    </p>
    @if (!service.eligible()) {
      <p role="status">Leitura não disponível: requer operador conectado em modo REAL.</p>
    }
    @if (service.loading() && !service.view()) {
      <p role="status">Consultando estado observado…</p>
    }
    @if (service.error()) {
      <p role="alert">{{ service.error() }}</p>
    }
    <figure>
      @if (curve(); as graph) {
        <svg
          viewBox="0 0 720 300"
          role="img"
          aria-label="Estimativa teórica das quatro bandas; frequência em Hz, ganho em dB"
        >
          @for (db of [-20, -10, 0, 10, 20]; track db) {
            <line x1="40" x2="700" [attr.y1]="140 - db * 5" [attr.y2]="140 - db * 5" />
            <text x="0" [attr.y]="144 - db * 5">{{ db }}</text>
          }
          @for (hz of [20, 100, 1000, 10000, 22050]; track hz) {
            <text [attr.x]="x(hz)" y="290" text-anchor="middle">{{ hz }}</text>
          }
          <path [attr.d]="graph.path" [attr.stroke-dasharray]="graph.old ? '8 5' : null" />
          @if (hpfMarker(); as hz) {
            <line class="hpf-marker" [attr.x1]="x(hz)" [attr.x2]="x(hz)" y1="20" y2="260" />
          }
          @for (m of marks(); track m.band) {
            <g class="band-dot" [attr.data-dot]="m.band" [class.is-old]="m.old" [class.is-selected]="selectedBand() === m.band" tabindex="0" role="button"
               [attr.aria-label]="'Banda ' + m.band + ': ' + m.label + (m.old ? ' (amostra antiga)' : '')" (click)="selectedBand.set(m.band)" (keydown.enter)="selectedBand.set(m.band)">
              <circle [attr.cx]="m.cx" [attr.cy]="m.cy" r="13" />
              <text [attr.x]="m.cx" [attr.y]="m.cy + 4" text-anchor="middle">{{ m.band }}</text>
            </g>
          }
        </svg>
        <figcaption>
          Estimativa RBJ a 48 kHz, não resposta medida da Ui16. HPF: apenas marcador; slope
          indisponível, fora da curva. {{ graph.old ? 'Tracejado: inclui última observação.' : '' }}
        </figcaption>
      } @else {
        <p class="empty">
          Curva indisponível: requer as quatro bandas e bypass conhecidos na conexão atual.
        </p>
      }
    </figure>
    <section class="readout" aria-label="Banda selecionada" data-testid="eq-readout" [attr.data-selected]="selectedBand()">
      <h3>Banda {{ selectedBand() }}</h3>
      @for (field of fields; track field.key) {
        <div class="cell">
          <span>{{ field.label.toUpperCase() }}</span>
          <strong data-testid="eq-readout-value">{{ text('b' + selectedBand() + '.' + field.key, field.unit) }}</strong>
          <small [attr.data-quality]="service.reading('b' + selectedBand() + '.' + field.key).state">{{ status(service.reading('b' + selectedBand() + '.' + field.key)) }}</small>
        </div>
      }
    </section>
    <div class="bands">
      @for (band of [1, 2, 3, 4]; track band) {
        <article [attr.data-band]="band" [class.is-selected]="selectedBand() === band">
          <h3>Banda {{ band }}</h3>
          <dl>
            @for (field of fields; track field.key) {
              <dt>{{ field.label }}</dt>
              <dd>
                <strong>{{ text('b' + band + '.' + field.key, field.unit) }}</strong
                ><small [attr.data-quality]="service.reading('b' + band + '.' + field.key).state">{{
                  status(service.reading('b' + band + '.' + field.key))
                }}</small>
              </dd>
            }
          </dl>
        </article>
      }
    </div>
    <div class="filters">
      <article>
        <h3>HPF</h3>
        <strong>{{ text('hpf.freq', 'Hz') }}</strong
        ><small>{{ status(service.reading('hpf.freq')) }}</small>
        <p>{{ hpfState() }}</p>
      </article>
      <article>
        <h3>Bypass do EQ</h3>
        <strong>{{ bypass() }}</strong
        ><small>{{ status(service.reading('bypass')) }}</small>
      </article>
    </div>
    @if (embedded()) {
      <nav class="channel-tabs" aria-label="Canal do EQ">
        @for (ch of service.live.channels(); track ch.number) {
          <button type="button" [class.on]="ch.number === channel()" [attr.aria-pressed]="ch.number === channel()" (click)="channelChanged.emit(ch.number)">
            <small>CH {{ ch.number }}</small>{{ ch.name }}
          </button>
        }
      </nav>
    }
    <footer>
      Origem: entrada independente do socket. “Confirmado” indica parâmetro recebido, não medição
      acústica nem ACK de comando. Última observação serve para consulta; não autoriza escrita.
    </footer>
  </section>`,
  styles: [
    `
      :host:not(.embedded) {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: #000b;
        display: grid;
        place-items: center;
        padding: 16px;
        overflow: auto;
        color: var(--text);
      }
      .panel {
        width: min(1120px, 100%);
        max-height: 94dvh;
        overflow: auto;
        padding: 24px;
        background: var(--panel, #152029);
        border: 1px solid var(--line);
        border-radius: 12px;
        box-shadow: 0 12px 60px #0009;
      }
      header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
      }
      h2 {
        margin: 6px 0;
        font-size: 1.25rem;
      }
      h3 {
        margin: 0 0 16px;
      }
      small,
      footer,
      figcaption {
        color: var(--muted);
        font-size: 0.85rem;
      }
      small {
        display: block;
      }
      header small,
      .notice {
        color: var(--warn);
      }
      select {
        min-height: 48px;
        max-width: 100%;
        margin: 8px;
        background: var(--panel-2);
        color: var(--text);
        font: inherit;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
      }
      .btn {
        min-height: 48px;
      }
      figure {
        margin: 16px 0;
        background: #0c141e;
        border-radius: 8px;
        padding: 12px;
      }
      svg {
        width: 100%;
        max-height: 200px;
      }
      svg line {
        stroke: #354454;
      }
      svg text {
        fill: #b8c6d4;
        font-size: 12px;
      }
      svg path {
        fill: none;
        stroke: #65d4f5;
        stroke-width: 3;
      }
      svg .hpf-marker {
        stroke: #dfb86a;
        stroke-dasharray: 4 4;
      }
      .bands {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      article {
        border: 1px solid var(--line);
        border-top: 3px solid #65d4f5;
        border-radius: 8px;
        padding: 16px;
        background: var(--panel-2);
      }
      article[data-band='2'] {
        border-top-color: #dfb86a;
      }
      article[data-band='3'] {
        border-top-color: #b79eff;
      }
      article[data-band='4'] {
        border-top-color: #f18ea6;
      }
      dl {
        margin: 0;
      }
      dt {
        color: var(--muted);
        margin-top: 6px;
      }
      dd {
        margin: 4px 0;
      }
      strong {
        font-variant-numeric: tabular-nums;
        font-size: 1.15rem;
      }
      dd small {
        margin-top: 4px;
      }
      [data-quality='stale'] {
        color: var(--warn);
      }
      .filters {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin: 12px 0;
      }
      footer {
        line-height: 1.6;
      }
      .empty {
        min-height: 110px;
        display: grid;
        place-items: center;
      }
      :host.embedded { display: block; color: var(--text); }
      :host.embedded p { margin: 2px 0; font-size: 0.85rem; }
      :host.embedded h2 { margin: 2px 0; }
      :host.embedded .notice { font-size: 0.8rem; }
      /* telas largas: gráfico em destaque à esquerda; leitura, bandas e filtros em coluna à direita */
      @media (min-width: 1000px) {
        :host.embedded .panel { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 8px 14px; grid-auto-flow: row dense; align-items: start; }
        :host.embedded .panel > * { grid-column: 1 / -1; }
        :host.embedded .panel > figure { grid-column: 1; grid-row: span 3; margin: 0; }
        :host.embedded .panel > .readout, :host.embedded .panel > .bands, :host.embedded .panel > .filters { grid-column: 2; margin: 0; }
        :host.embedded .panel > .readout { grid-template-columns: repeat(3, 1fr); }
        :host.embedded .panel > .readout h3 { grid-column: 1 / -1; }
        :host.embedded .panel > .bands { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        :host.embedded .bands article dd small { font-size: 0.7rem; }
        :host.embedded svg { aspect-ratio: auto; height: 100%; max-height: 360px; min-height: 240px; }
      }
      :host.embedded .panel { width: 100%; max-height: none; border-radius: 6px; padding: 12px 14px; background: linear-gradient(180deg, #1d2229, #11151a); border: 1px solid #3a424d; box-shadow: inset 0 1px 0 #ffffff14; }
      :host.embedded figure { background: #0b0e12; border: 1px solid #2a313a; margin: 8px 0; }
      :host.embedded svg { max-height: none; aspect-ratio: 720 / 300; }
      :host.embedded .bands { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      :host.embedded .bands article { padding: 8px 10px; }
      :host.embedded .bands h3, :host.embedded .filters h3 { margin: 0 0 6px; font-size: 0.9rem; }
      :host.embedded .filters { margin: 8px 0; }
      .band-dot { cursor: pointer; }
      .band-dot circle { fill: #65d4f566; stroke: #65d4f5; stroke-width: 2; }
      .band-dot[data-dot='2'] circle { fill: #dfb86a66; stroke: #dfb86a; }
      .band-dot[data-dot='3'] circle { fill: #b79eff66; stroke: #b79eff; }
      .band-dot[data-dot='4'] circle { fill: #f18ea666; stroke: #f18ea6; }
      .band-dot.is-selected circle { stroke-width: 4; }
      .band-dot.is-old circle { stroke-dasharray: 4 3; fill-opacity: 0.25; }
      .band-dot text { fill: #fff; font-weight: 700; }
      .band-dot:focus-visible { outline: none; } .band-dot:focus-visible circle { stroke: #fff; }
      article.is-selected { box-shadow: 0 0 0 2px #fff3; }
      .readout { display: grid; grid-template-columns: auto repeat(3, 1fr); gap: 10px; align-items: center; margin: 8px 0; padding: 8px 12px; background: #0b0e12; border: 1px solid #2a313a; border-radius: 6px; }
      .readout h3 { margin: 0; font-size: 0.95rem; }
      .readout .cell { display: grid; gap: 2px; text-align: center; }
      .readout .cell span { font-size: 0.7rem; letter-spacing: 0.08em; color: var(--muted); }
      .readout .cell strong { font-size: 1.3rem; color: #7ee7ff; text-shadow: 0 0 6px #3fd0f544; background: #07161c; border: 1px solid #1c3a45; border-radius: 4px; padding: 2px 6px; }
      .bypass-lamp { font-size: 0.8rem; padding: 6px 10px; border: 1px solid #3a424d; border-radius: 4px; background: #14181d; color: var(--muted); }
      .bypass-lamp.on { color: #10151a; background: var(--warn); }
      .bypass-lamp.unknown { color: var(--muted); font-style: italic; }
      .channel-tabs { display: flex; gap: 2px; overflow-x: auto; margin-top: 10px; padding-bottom: 2px; }
      .channel-tabs button { flex: 1 0 74px; min-height: 48px; background: linear-gradient(180deg, #2b3138, #191d22); color: var(--text); border: 0; border-bottom: 3px solid #4a525c; font: inherit; font-weight: 700; font-size: 0.8rem; cursor: pointer; padding: 4px 6px; }
      .channel-tabs button small { display: block; color: var(--muted); font-weight: 400; font-size: 0.65rem; }
      .channel-tabs button.on { background: linear-gradient(180deg, #e86a3a, #b8481f); border-bottom-color: #ffb08a; color: #fff; }
      .channel-tabs button.on small { color: #ffe3d4; }
      @media (max-width: 900px) {
        :host.embedded .bands { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .readout { grid-template-columns: repeat(3, 1fr); } .readout h3 { grid-column: 1 / -1; }
      }
      @media (max-width: 900px) {
        .bands {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 500px) {
        :host {
          padding: 6px;
        }
        .panel {
          padding: 12px;
        }
        header {
          align-items: start;
        }
        h2 {
          font-size: 1rem;
        }
        .bands,
        .filters {
          grid-template-columns: 1fr;
        }
        select {
          margin-left: 0;
        }
      }
    `,
  ],
})
export class LiveEqComponent {
  readonly service = inject(LiveEqService);
  readonly channel = input.required<number>();
  /** Dentro de EDIT (inline, sem janela modal): sem foco automático, sem Esc/armadilha de foco. */
  readonly embedded = input(false);
  readonly selectedBand = signal<1 | 2 | 3 | 4>(1);
  readonly closed = output<void>();
  readonly channelChanged = output<number>();
  readonly fields = [
    { key: 'freq', label: 'Frequência', unit: 'Hz' },
    { key: 'gain', label: 'Ganho', unit: 'dB' },
    { key: 'q', label: 'Q', unit: '' },
  ];
  readonly name = computed(
    () =>
      this.service.live.channels().find((c) => c.number === this.channel())?.name ??
      'Nome indisponível',
  );
  readonly curve = computed(() => bandCurve((s) => this.service.reading(s)));
  /** Marcadores numerados nas coordenadas (freq, ganho) observadas; sem as duas leituras, sem marcador (nada é inventado). */
  readonly marks = computed(() =>
    ([1, 2, 3, 4] as const).flatMap((band) => {
      const f = this.service.reading('b' + band + '.freq'), g = this.service.reading('b' + band + '.gain');
      const ok = (r: Reading) => typeof r.value === 'number' && ['confirmed', 'last_observation', 'stale'].includes(r.state);
      if (!ok(f) || !ok(g)) return [];
      const gain = Math.max(-20, Math.min(20, g.value as number));
      return [{ band, cx: this.x(Math.max(20, Math.min(22050, f.value as number))), cy: 140 - gain * 5,
        old: f.state !== 'confirmed' || g.state !== 'confirmed', label: this.text('b' + band + '.freq', 'Hz') + ', ' + this.text('b' + band + '.gain', 'dB') }];
    }),
  );
  readonly hpfMarker = computed(() => {
    const r = this.service.reading('hpf.freq');
    return r.current &&
      ['confirmed', 'last_observation'].includes(r.state) &&
      r.raw !== 0 &&
      typeof r.value === 'number'
      ? r.value
      : null;
  });
  readonly hpfState = computed(() => {
    const r = this.service.reading('hpf.freq');
    return r.value === undefined
      ? 'Estado indisponível'
      : r.raw === 0
        ? 'Desligado na amostra (valor bruto zero)'
        : 'Frequência na amostra; sem setter de bypass separado.';
  });
  readonly bypass = computed(() => {
    const v = this.service.reading('bypass').value;
    return typeof v === 'boolean' ? (v ? 'Sim' : 'Não') : 'Desconhecido';
  });
  private readonly element: ElementRef<HTMLElement> = inject(ElementRef);
  constructor() {
    const previous = document.activeElement;
    effect(() => this.service.channel.set(this.channel()));
    afterNextRender(() => { if (!this.embedded()) this.element.nativeElement.querySelector<HTMLElement>('h2')?.focus(); });
    inject(DestroyRef).onDestroy(() => {
      if (!this.embedded() && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  }
  escape() { if (!this.embedded()) this.closed.emit(); }
  x(hz: number) {
    return 40 + (Math.log(hz / 20) / Math.log(22050 / 20)) * 660;
  }
  text(suffix: string, unit: string) {
    const r = this.service.reading(suffix);
    return typeof r.value === 'number'
      ? r.value.toLocaleString('pt-BR', {
          minimumFractionDigits: unit === 'Hz' ? 0 : unit === 'dB' ? 1 : 2,
          maximumFractionDigits: unit === 'Hz' ? 0 : unit === 'dB' ? 1 : 2,
        }) + (unit ? ' ' + unit : '')
      : 'Não disponível';
  }
  status(r: Reading) {
    return (
      qualityLabel(r.state) + (r.ageMs === null ? '' : ` · há ${Math.floor(r.ageMs / 1000)} s`)
    );
  }
  trap(event: Event) {
    if (this.embedded()) return;
    const e = event as KeyboardEvent;
    const nodes = Array.from(
      this.element.nativeElement.querySelectorAll<HTMLElement>('button, select, [tabindex="0"]'),
    );
    const first = nodes[0],
      last = nodes.at(-1);
    if (!first || !last) return;
    if (
      e.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === this.element.nativeElement.querySelector('h2'))
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

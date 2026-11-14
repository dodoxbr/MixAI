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
} from '@angular/core';
import { LiveEqService } from './live-eq.service';
import { bandCurve, qualityLabel, type Reading } from './processing-view';
@Component({
  selector: 'mx-live-eq',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [LiveEqService],
  host: {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'EQ e HPF REAL — somente leitura',
    '(keydown.escape)': 'closed.emit()',
    '(keydown.tab)': 'trap($event)',
  },
  template: ` <section class="panel">
    <header>
      <div>
        <small>REAL · SOMENTE LEITURA</small>
        <h2 tabindex="-1">EQ / HPF · CH{{ channel() }} — {{ name() }}</h2>
      </div>
      <button class="btn" (click)="closed.emit()">Fechar EQ/HPF</button>
    </header>
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
    <div class="bands">
      @for (band of [1, 2, 3, 4]; track band) {
        <article [attr.data-band]="band">
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
    <footer>
      Origem: entrada independente do socket. “Confirmado” indica parâmetro recebido, não medição
      acústica nem ACK de comando. Última observação serve para consulta; não autoriza escrita.
    </footer>
  </section>`,
  styles: [
    `
      :host {
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
    afterNextRender(() => this.element.nativeElement.querySelector<HTMLElement>('h2')?.focus());
    inject(DestroyRef).onDestroy(() => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
  }
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

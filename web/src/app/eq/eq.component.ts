import { ChangeDetectionStrategy, Component, computed, effect, inject, output, signal } from '@angular/core';
import { ActionsService } from '../core/actions.service';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { compareEqGuide, eqGuideContext, eqGuides, eqValues, type EqGuide } from '../../../../src/knowledge/sound-engineer/eq-guides';
import { eqFilters, magnitudeDB, plotFrequency, plotPosition, type EqResponse } from '../../../../src/core/eq-response';

@Component({
  selector: 'mx-eq',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'eq-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Equalizador LAB', '(keydown.escape)': 'closed.emit()' },
  template: `
    <header>
      <h2>Equalizador LAB</h2>
      <button class="btn" (click)="closed.emit()">Fechar EQ</button>
    </header>
    <p class="eq-notice">SIMULADO — somente laboratório. Curva estimada, não medida na Ui16 real.</p>
    <label
      >Canal
      <select aria-label="Canal do EQ" [value]="channel()" (change)="selectChannel(+$any($event.target).value)">
        @for (ch of live.channels(); track ch.number) {
          <option [value]="ch.number">{{ ch.name }}</option>
        }
      </select></label
    >
    <p>Modelo digital a 48 kHz. HPF Butterworth; 20 Hz desliga o HPF. Bypass desliga bandas e HPF.</p>
    @if (eq(); as model) {
      <svg class="eq-graph" viewBox="0 0 720 300" role="img" aria-label="Curva estimada de magnitude: frequência em Hz e ganho em dB">
        @for (db of [-20, -10, 0, 10, 20]; track db) {
          <line x1="40" x2="700" [attr.y1]="y(db)" [attr.y2]="y(db)" stroke="#354454" />
          <text x="2" [attr.y]="y(db) + 4">{{ db }}</text>
        }
        @for (hz of [20, 100, 1000, 10000, 22050]; track hz) {
          <text [attr.x]="x(hz)" y="292" text-anchor="middle">{{ hz }}</text>
        }
        <path [attr.d]="path()" fill="none" stroke="#65d4f5" stroke-width="3" />
        @if (reviewed(); as guide) {
          <path data-testid="eq-guide-curve" [attr.d]="guidePath()" fill="none" stroke="#ffce73" stroke-width="3" stroke-dasharray="8 4" />
        }
        @for (b of preview()!.bands; track $index; let i = $index) {
          <circle
            [attr.cx]="x(b.freq)"
            [attr.cy]="y(b.gain)"
            r="14"
            fill="#be9bff"
            tabindex="0"
            role="button"
            [attr.aria-label]="'Arrastar banda ' + (i + 1) + '; setas alteram frequência e ganho'"
            [attr.aria-disabled]="disabled()"
            (pointerdown)="start($event, i)"
            (pointermove)="move($event)"
            (pointerup)="end($event)"
            (pointercancel)="cancel()"
            (lostpointercapture)="cancel()"
            (keydown)="key($event, i)"
          />
        }
      </svg>
      @if (live.hello()?.mode === 'lab') {
        <section class="eq-guides" aria-label="Presets orientativos MixAI">
          <h3>Presets orientativos MixAI</h3>
          <p>SIMULADO — somente LAB; referência inicial, não medida na Ui16. Não é snapshot da Soundcraft.</p>
          <p>Pontos de partida não universais. Microfone, acústica, afinação e instrumento mudam o resultado. Não há escuta ou medição de áudio.</p>
          <label>Preset orientativo
            <select aria-label="Preset orientativo" [disabled]="disabled()" [value]="reviewed()?.id ?? ''" (change)="selectGuide($any($event.target).value)">
              <option value="">Selecione para comparar</option>
              @for (guide of guides; track guide.id) { <option [value]="guide.id">{{ guide.name }}</option> }
            </select>
          </label>
          @if (reviewed(); as guide) {
            <h4>{{ guide.name }} — prévia no canal {{ channel() }}</h4>
            <p>{{ guide.purpose }}</p>
            <p><strong>Justificativa:</strong> {{ guide.rationale }}</p>
            <p><strong>Contraindicações:</strong> {{ guide.contraindication }} {{ context()!.instrument.avoid }}</p>
            <p><strong>Antes de decidir:</strong> {{ context()!.instrument.captureChecks.join(' ') }}</p>
            <p>Curva azul contínua: EQ LAB atual. Curva amarela tracejada: preset proposto. Curvas estimadas a 48 kHz, sem equivalência garantida ao firmware Ui16.</p>
            <p>Aplicar substitui as quatro bandas, HPF e bypass deste canal. HPF em 20 Hz significa desligado no LAB. Bypass será desligado.</p>
            <div class="eq-diff-scroll" tabindex="0" role="region" aria-label="Comparação de parâmetros de EQ">
              <table class="eq-diff">
                <caption>EQ LAB atual × preset proposto — valores diferentes destacados</caption>
                <thead><tr><th scope="col">Parâmetro</th><th scope="col">Atual</th><th scope="col">Proposto</th></tr></thead>
                <tbody>
                  @for (row of diff(); track row.key) {
                    <tr [class.changed]="row.current !== row.proposed">
                      <th scope="row">{{ row.label }}</th><td>{{ format(row.current) }} {{ row.unit }}</td><td>{{ format(row.proposed) }} {{ row.unit }} {{ row.current !== row.proposed ? '(muda)' : '' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p><strong>Referências de princípios (os números são escolhas editoriais MixAI, não receitas das fontes):</strong></p>
            <ul>
              @for (ref of context()!.references; track ref.source) {
                <li><a [href]="ref.url" target="_blank" rel="noopener noreferrer">{{ ref.title }}</a> — {{ ref.locator }}</li>
              }
            </ul>
            <div class="eq-guide-actions">
              <button class="btn" [disabled]="disabled()" (click)="applyGuide()">Aplicar no LAB</button>
              <button class="btn" (click)="cancelGuide()">Cancelar preset</button>
            </div>
          }
          <p role="status">{{ guideNotice() }}</p>
          <button class="btn" [disabled]="disabled() || actions.isBusy('undo')" (click)="undo()">Desfazer última ação LAB</button>
          <p>Desfazer usa o histórico existente; confira a última ação, que pode ter vindo de outro operador.</p>
        </section>
      }
      <fieldset [disabled]="disabled()">
        <legend>Parâmetros do canal</legend>
        <div class="eq-bands">
          @for (b of model.bands; track $index; let i = $index) {
            <section>
              <h3>Banda {{ i + 1 }}</h3>
              <label
                >Frequência (Hz)<input
                  type="number"
                  [attr.aria-label]="'Banda ' + (i + 1) + ' frequência'"
                  min="20"
                  max="22050"
                  [value]="b.freq"
                  (change)="set('b' + (i + 1) + '.freq', +$any($event.target).value)"
              /></label>
              <label
                >Q<input
                  type="number"
                  [attr.aria-label]="'Banda ' + (i + 1) + ' Q'"
                  min="0.05"
                  max="15"
                  step="0.05"
                  [value]="b.q"
                  (change)="set('b' + (i + 1) + '.q', +$any($event.target).value)"
              /></label>
              <label
                >Ganho (dB)<input
                  type="number"
                  [attr.aria-label]="'Banda ' + (i + 1) + ' ganho'"
                  min="-20"
                  max="20"
                  step="0.5"
                  [value]="b.gain"
                  (change)="set('b' + (i + 1) + '.gain', +$any($event.target).value)"
              /></label>
            </section>
          }
        </div>
        <div class="eq-hpf">
          <label
            >HPF (Hz)<input
              aria-label="HPF frequência"
              type="number"
              min="20"
              max="1000"
              [value]="model.hpf.freq"
              (change)="set('hpf.freq', +$any($event.target).value)"
          /></label>
          <label
            >Inclinação (dB/oitava)<select
              aria-label="HPF inclinação"
              [value]="model.hpf.slope"
              (change)="set('hpf.slope', +$any($event.target).value)"
            >
              <option>12</option>
              <option>24</option>
              <option>36</option>
            </select></label
          >
          <label
            ><input type="checkbox" [checked]="model.bypass" (change)="set('bypass', $any($event.target).checked)" /> Bypass EQ/HPF</label
          >
          <button class="btn" (click)="reset()">Reset EQ do canal</button>
        </div>
      </fieldset>
    } @else {
      <p role="status">Aguardando parâmetros do servidor.</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: fixed;
        inset: 0;
        z-index: 50;
        overflow: auto;
        background: #101923;
        padding: 20px;
        color: #edf4fc;
      }
      header,
      .eq-hpf {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
      }
      header h2 {
        flex: 1;
      }
      .eq-notice {
        background: #173b57;
        padding: 12px;
        border: 1px solid #65d4f5;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .eq-graph {
        display: block;
        width: 100%;
        max-width: 1100px;
        margin: auto;
      }
      svg text {
        fill: #cad7e4;
        font-size: 13px;
      }
      circle {
        touch-action: none;
        cursor: grab;
        stroke: transparent;
        stroke-width: 36px;
        vector-effect: non-scaling-stroke;
        pointer-events: all;
      }
      circle:focus {
        outline: 2px solid white;
      }
      .eq-guides { border: 1px solid #698096; padding: 12px; margin: 12px 0; }
      .eq-guides a { color: #65d4f5; overflow-wrap: anywhere; }
      .eq-guide-actions { display: flex; gap: 12px; flex-wrap: wrap; }
      .eq-guide-actions .btn { min-height: 48px; }
      .eq-diff-scroll { overflow-x: auto; }
      .eq-diff { border-collapse: collapse; width: 100%; }
      .eq-diff th, .eq-diff td { padding: 8px; text-align: left; border-bottom: 1px solid #354454; }
      .eq-diff .changed { background: #263b4d; }
      .eq-bands {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 16px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 8px 0;
      }
      input,
      select {
        min-height: 48px;
        min-width: 0;
        width: 100%;
        background: #1c2b39;
        color: inherit;
        border: 1px solid #698096;
        border-radius: 6px;
        padding: 8px;
      }
      input[type='checkbox'] {
        width: 48px;
      }
      fieldset {
        border: 1px solid #354454;
      }
      .eq-hpf {
        margin-top: 12px;
      }
      @media (max-width: 720px) {
        :host {
          padding: 12px;
        }
        .eq-bands {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .eq-hpf {
          align-items: stretch;
        }
      }
    `,
  ],
})
export class EqComponent {
  readonly live = inject(LiveService);
  readonly actions = inject(ActionsService);
  private readonly session = inject(SessionService);
  readonly closed = output<void>();
  readonly guides = eqGuides;
  readonly guideNotice = signal('Selecionar um preset não altera o EQ.');
  private readonly selection = signal<{ guide: EqGuide; stamp: string } | null>(null);
  private readonly stamp = computed(() => JSON.stringify([
    this.session.token(), this.live.hello()?.serverId, this.live.hello()?.mode, this.live.hello()?.role, this.channel(),
    Object.entries(this.live.state()?.params ?? {}).filter(([key]) => key.startsWith(`ch.${this.channel()}.eq.`)),
  ]));
  readonly reviewed = computed(() => {
    const s = this.selection();
    return s && !this.disabled() && s.stamp === this.stamp() ? s.guide : null;
  });
  readonly context = computed(() => this.reviewed() ? eqGuideContext(this.reviewed()!) : null);
  readonly diff = computed(() => this.reviewed() && this.eq() ? compareEqGuide(this.eq()!, this.reviewed()!.model) : []);
  readonly guidePath = computed(() => this.curvePath(this.reviewed()?.model ?? null));
  constructor() {
    effect(() => {
      if (this.selection() && !this.reviewed()) {
        this.selection.set(null);
        this.guideNotice.set('Prévia descartada: canal, EQ, sessão ou conexão mudou. Selecione novamente e confira.');
      }
    });
  }
  selectChannel(channel: number) {
    this.cancelGuide();
    this.cancel();
    this.channel.set(channel);
  }
  selectGuide(id: string) {
    this.cancel();
    const guide = this.guides.find(g => g.id === id);
    if (!guide || this.disabled() || !this.eq()) { this.cancelGuide(); return; }
    this.selection.set({ guide, stamp: this.stamp() });
    this.guideNotice.set('Prévia somente. Confira as diferenças e decida se deseja aplicar no LAB.');
  }
  cancelGuide() {
    this.selection.set(null);
    this.guideNotice.set('Prévia cancelada. Nenhum preset aplicado.');
  }
  async applyGuide() {
    const guide = this.reviewed();
    if (!guide || !this.eq() || this.disabled()) return;
    // Explicit human button only; same validated LAB batch/permissions/history as E7A.
    this.selection.set(null);
    this.guideNotice.set('Aplicando no LAB; aguarde a resposta do servidor.');
    const token = this.session.token();
    const r = await this.actions.run('eq', {
      type: 'set_lab_eq', channel: this.channel(),
      values: Object.fromEntries(Object.entries(eqValues(guide.model)).map(([key, value]) => [`ch.${this.channel()}.eq.${key}`, value])),
    });
    if (token === this.session.token()) this.guideNotice.set(r.ok ? 'Preset aplicado somente no LAB. Pode desfazer pelo histórico.' : r.message);
  }
  undo() {
    if (this.disabled() || this.actions.isBusy('undo')) return;
    this.cancelGuide();
    void this.actions.run('undo', { type: 'undo' }, r => r.message);
  }
  format(value: number | boolean) { return typeof value === 'boolean' ? value ? 'Ligado' : 'Desligado' : value; }
  readonly channel = signal(this.live.channels()[0]?.number ?? 1);
  readonly disabled = computed(
    () => !this.live.writable() || this.live.hello()?.mode !== 'lab' || this.live.hello()?.role !== 'operator' || this.actions.isBusy('eq') || this.actions.isBusy('undo'),
  );
  private read(suffix: string): number | boolean | undefined {
    const v = this.live.state()?.params[`ch.${this.channel()}.eq.${suffix}`]?.value;
    return v?.status === 'known' ? v.value : undefined;
  }
  readonly eq = computed<EqResponse | null>(() => {
    const bands = [1, 2, 3, 4].map((i) => ({ freq: this.read(`b${i}.freq`), q: this.read(`b${i}.q`), gain: this.read(`b${i}.gain`) }));
    const freq = this.read('hpf.freq'),
      slope = this.read('hpf.slope'),
      bypass = this.read('bypass');
    if (
      bands.some((b) => typeof b.freq !== 'number' || typeof b.q !== 'number' || typeof b.gain !== 'number') ||
      typeof freq !== 'number' ||
      typeof slope !== 'number' ||
      typeof bypass !== 'boolean'
    )
      return null;
    return { bands, hpf: { freq, slope }, bypass } as EqResponse;
  });
  readonly path = computed(() => this.curvePath(this.preview()));
  private curvePath(model: EqResponse | null) {
    if (!model) return '';
    const filters = eqFilters(model);
    return Array.from({ length: 401 }, (_, i) => {
      const f = plotFrequency(i / 400);
      return `${i ? 'L' : 'M'}${this.x(f)},${this.y(magnitudeDB(filters, f))}`;
    }).join(' ');
  }
  x(freq: number) {
    return 40 + 660 * plotPosition(freq);
  }
  y(db: number) {
    return 140 - Math.max(-24, Math.min(24, db)) * 5;
  }
  set(suffix: string, value: number | boolean) {
    this.send({ [suffix]: value });
  }
  private send(values: Record<string, number | boolean>) {
    if (this.disabled()) return;
    this.cancelGuide();
    void this.actions.run('eq', {
      type: 'set_lab_eq',
      channel: this.channel(),
      values: Object.fromEntries(Object.entries(values).map(([k, v]) => [`ch.${this.channel()}.eq.${k}`, v])),
    });
  }
  reset() {
    if (this.disabled()) return;
    this.cancelGuide();
    void this.actions.run('eq', { type: 'reset_lab_eq', channel: this.channel() });
  }
  // Only the current pointer gesture is local; committed parameters come from LiveService.
  private readonly drag = signal<{ pointer: number; band: number; channel: number; freq: number; gain: number } | null>(null);
  readonly preview = computed(() => {
    const model = this.eq(),
      d = this.drag();
    if (!model || !d || d.channel !== this.channel() || this.disabled()) return model;
    return { ...model, bands: model.bands.map((b, i) => (i === d.band ? { ...b, freq: d.freq, gain: d.gain } : b)) };
  });
  start(e: PointerEvent, band: number) {
    if (this.disabled()) return;
    e.preventDefault();
    this.cancelGuide();
    const b = this.eq()!.bands[band]!;
    this.drag.set({ pointer: e.pointerId, band, channel: this.channel(), freq: b.freq, gain: b.gain });
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  move(e: PointerEvent) {
    const d = this.drag();
    if (!d || d.pointer !== e.pointerId) return;
    const rect = (e.target as SVGElement).ownerSVGElement!.getBoundingClientRect();
    const freq = Math.round(plotFrequency((((e.clientX - rect.left) / rect.width) * 720 - 40) / 660));
    const gain = Math.max(-20, Math.min(20, Math.round(((140 - ((e.clientY - rect.top) / rect.height) * 300) / 5) * 2) / 2));
    this.drag.set({ ...d, freq, gain });
  }
  end(e: PointerEvent) {
    if (this.drag()?.pointer !== e.pointerId) return;
    this.move(e);
    const d = this.drag()!;
    this.drag.set(null);
    if (d.channel === this.channel()) this.send({ [`b${d.band + 1}.freq`]: d.freq, [`b${d.band + 1}.gain`]: d.gain });
  }
  cancel() {
    this.drag.set(null);
  }
  key(e: KeyboardEvent, i: number) {
    const b = this.eq()?.bands[i];
    if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      this.set(`b${i + 1}.freq`, Math.max(20, Math.min(22050, Math.round(b.freq * (e.key === 'ArrowRight' ? 1.05 : 1 / 1.05)))));
    else this.set(`b${i + 1}.gain`, Math.max(-20, Math.min(20, b.gain + (e.key === 'ArrowUp' ? 0.5 : -0.5))));
  }
}

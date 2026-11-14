import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { dbToPos, formatDb, posToDb, SCALE_MARKS, stepDb } from '../core/db';

export interface FaderMove {
  db: number;
  final: boolean;
}

/** Geometria do SVG (unidades do viewBox). A altura acompanha o espaço real do canal. */
const WIDTH = 64;
const TOP = 16;
const MARGIN_BOTTOM = 16;
/** No máximo ~30 mensagens por segundo durante o arraste. */
const EMIT_MS = 33;

/**
 * Fader vertical em SVG.
 * - Arraste RELATIVO: tocar fora do botão não faz o fader pular (evita mudança acidental).
 * - Pointer events + touch-action: none (mouse, caneta e toque no Yoga/celular).
 * - Teclado: ↑/↓ 1 dB, PageUp/PageDown 5 dB, Home = 0 dB, End = -∞.
 * - Mostra o valor do servidor; durante o arraste mostra o valor da mão (otimista) e,
 *   ao soltar, volta a seguir o servidor (se ele recusar, o fader volta sozinho).
 */
@Component({
  selector: 'mx-fader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-fader', '[class.is-dragging]': 'dragging()', '[class.is-disabled]': 'disabled()' },
  template: `
    <svg
      [attr.viewBox]="'0 0 64 ' + vbHeight()"
      role="slider"
      [attr.tabindex]="disabled() ? -1 : 0"
      [attr.aria-label]="label()"
      aria-orientation="vertical"
      aria-valuemin="-80"
      aria-valuemax="10"
      [attr.aria-valuenow]="ariaNow()"
      [attr.aria-valuetext]="text()"
      [attr.aria-disabled]="disabled()"
      (pointerdown)="down($event)"
      (pointermove)="move($event)"
      (pointerup)="up($event)"
      (pointercancel)="cancel($event)"
      (lostpointercapture)="up($event)"
      (keydown)="key($event)"
    >
      <defs>
        <linearGradient id="mx-thumb-metal" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f4f5f6" /><stop offset="0.45" stop-color="#b8bcc1" /><stop offset="0.5" stop-color="#8f949a" /><stop offset="1" stop-color="#d3d6d9" /></linearGradient>
        <linearGradient id="mx-thumb-red" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff7e7e" /><stop offset="0.5" stop-color="#d63a3a" /><stop offset="1" stop-color="#8f1d1d" /></linearGradient>
      </defs>
      @for (m of marks; track m.label) {
        <line class="tick" x1="8" [attr.x2]="m.db === 0 ? 22 : 18" [attr.y1]="y(m.db)" [attr.y2]="y(m.db)" />
        <text class="tick-label" x="6" [attr.y]="y(m.db) + 3">{{ m.label }}</text>
      }
      <rect class="track" x="38" [attr.y]="top" width="6" [attr.height]="span()" rx="3" />
      @if(shown()!==null){
      <rect class="track-fill" x="38" [attr.y]="thumbY()" width="6" [attr.height]="bottom() - thumbY()" rx="3" />
      <g class="thumb" [attr.transform]="'translate(0,' + thumbY() + ')'">
        <rect x="22" y="-14" width="38" height="28" rx="5" />
        <line x1="26" x2="56" y1="0" y2="0" />
        <line class="grip" x1="26" x2="56" y1="-6" y2="-6" />
        <line class="grip" x1="26" x2="56" y1="6" y2="6" />
      </g>
      }
    </svg>
  `,
})
export class FaderComponent {
  /** Valor do servidor em dB (-Infinity = fundo); null = desconhecido/indisponível. */
  readonly value = input<number | null>(null);
  readonly disabled = input(false);
  readonly label = input('fader');
  readonly moved = output<FaderMove>();

  readonly marks = SCALE_MARKS;
  readonly top = TOP;
  /** Altura do viewBox: proporcional ao tamanho real, para o fader usar o canal inteiro. */
  readonly vbHeight = signal(300);
  readonly bottom = computed(() => this.vbHeight() - MARGIN_BOTTOM);
  readonly span = computed(() => this.bottom() - TOP);

  readonly dragging = signal(false);
  private readonly local = signal<number | null>(null);
  readonly shown = computed(() => (this.dragging() ? this.local() : this.value()));
  readonly thumbY = computed(() => {
    const v = this.shown();
    return this.bottom() - (v === null ? 0 : dbToPos(v)) * this.span();
  });
  readonly text = computed(() => (this.shown() === null ? 'desconhecido' : `${formatDb(this.shown())} dB`));
  readonly ariaNow = computed(() => {
    const v = this.shown();
    return v === null ? null : Number.isFinite(v) ? v : -80;
  });

  private startY = 0;
  private startPos = 0;
  private pointerId: number | null = null;
  private lastEmit = 0;
  private pendingEmit: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const host = inject(ElementRef).nativeElement as HTMLElement;
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(([entry]) => {
        const { width, height } = entry!.contentRect;
        if (width > 0 && height > 0) this.vbHeight.set(Math.round(Math.max(200, Math.min(1400, (WIDTH * height) / width))));
      });
      ro.observe(host);
      inject(DestroyRef).onDestroy(() => ro.disconnect());
    }
  }

  y(db: number): number {
    return this.bottom() - dbToPos(db) * this.span();
  }

  down(e: PointerEvent): void {
    if (this.disabled() || this.value() === null || this.pointerId !== null) return;
    e.preventDefault();
    const svg = e.currentTarget as SVGSVGElement;
    svg.setPointerCapture?.(e.pointerId);
    svg.focus?.({ preventScroll: true });
    this.pointerId = e.pointerId;
    this.startY = e.clientY;
    this.startPos = dbToPos(this.value()!);
    this.local.set(this.value());
    this.dragging.set(true);
  }

  move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const svg = e.currentTarget as SVGSVGElement;
    const h = svg.getBoundingClientRect?.().height || this.vbHeight();
    const usable = (h * this.span()) / this.vbHeight(); // pixels da parte útil do trilho
    const pos = this.startPos - (e.clientY - this.startY) / usable;
    const db = posToDb(pos);
    if (db === this.local()) return;
    this.local.set(db);
    this.throttledEmit();
  }

  up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    clearTimeout(this.pendingEmit);
    this.pendingEmit = undefined;
    const db = this.local();
    this.dragging.set(false);
    if (db !== null) this.moved.emit({ db, final: true });
  }

  /**
   * O sistema cancelou o toque (girou a tela, rolagem do navegador, notificação...). Não é um
   * "soltou": NADA é enviado. A tela volta a mostrar o valor do servidor; se o gesto já tinha
   * enviado valores, o servidor fecha o gesto sozinho (um item no desfazer), como quando a
   * conexão cai no meio de um arraste.
   */
  cancel(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    clearTimeout(this.pendingEmit);
    this.pendingEmit = undefined;
    this.dragging.set(false);
    this.local.set(null);
  }

  key(e: KeyboardEvent): void {
    if (this.disabled() || this.value() === null) return;
    const v = this.value()!;
    const map: Record<string, number | undefined> = {
      ArrowUp: stepDb(v, 1),
      ArrowRight: stepDb(v, 1),
      ArrowDown: stepDb(v, -1),
      ArrowLeft: stepDb(v, -1),
      PageUp: stepDb(v, 5),
      PageDown: stepDb(v, -5),
      Home: 0,
      End: -Infinity,
    };
    const next = map[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (next !== v) this.moved.emit({ db: next, final: true });
  }

  private throttledEmit() {
    const now = Date.now();
    const send = () => {
      this.pendingEmit = undefined;
      this.lastEmit = Date.now();
      const db = this.local();
      if (db !== null && this.dragging()) this.moved.emit({ db, final: false });
    };
    if (now - this.lastEmit >= EMIT_MS) send();
    else this.pendingEmit ??= setTimeout(send, EMIT_MS - (now - this.lastEmit));
  }
}

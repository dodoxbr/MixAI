import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FaderComponent, type FaderMove } from './fader.component';

@Component({
  imports: [FaderComponent],
  template: `<mx-fader [value]="value()" [disabled]="disabled()" (moved)="moves.push($event)" />`,
})
class Host {
  readonly value = signal<number | null>(-10);
  readonly disabled = signal(false);
  moves: FaderMove[] = [];
}

/** jsdom não tem PointerEvent completo: monta um evento com o que o fader usa. */
function pointer(el: Element, type: string, clientY: number, pointerId = 1) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  el.dispatchEvent(e);
}

function setup(value: number | null = -10) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.value.set(value);
  fixture.detectChanges();
  const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
  return { fixture, host: fixture.componentInstance, svg };
}

describe('fader SVG', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arraste para cima sobe o volume; ao soltar manda o valor final', () => {
    const { fixture, host, svg } = setup(-10);
    pointer(svg, 'pointerdown', 200);
    pointer(svg, 'pointermove', 150);
    vi.advanceTimersByTime(50);
    pointer(svg, 'pointermove', 100);
    vi.advanceTimersByTime(50);
    pointer(svg, 'pointerup', 100);
    fixture.detectChanges();
    const final = host.moves.at(-1)!;
    expect(final.final).toBe(true);
    expect(final.db).toBeGreaterThan(-10);
    expect(host.moves.some((m) => !m.final)).toBe(true); // valores durante o arraste
  });

  it('toque sem arrastar NÃO faz o fader pular (arraste relativo)', () => {
    const { host, svg } = setup(-10);
    pointer(svg, 'pointerdown', 20); // tocou bem no topo do trilho
    pointer(svg, 'pointerup', 20);
    expect(host.moves).toEqual([{ db: -10, final: true }]);
  });

  it('arraste até o fundo chega a -∞', () => {
    const { host, svg } = setup(-10);
    pointer(svg, 'pointerdown', 100);
    pointer(svg, 'pointermove', 2000);
    pointer(svg, 'pointerup', 2000);
    expect(host.moves.at(-1)).toEqual({ db: -Infinity, final: true });
  });

  it('durante o arraste mostra o valor da mão; depois volta a seguir o servidor', () => {
    const { fixture, host, svg } = setup(-10);
    const thumbY = () => fixture.nativeElement.querySelector('.thumb').getAttribute('transform');
    const before = thumbY();
    pointer(svg, 'pointerdown', 200);
    pointer(svg, 'pointermove', 120);
    fixture.detectChanges();
    expect(thumbY()).not.toBe(before);
    pointer(svg, 'pointerup', 120);
    fixture.detectChanges();
    expect(thumbY()).toBe(before); // servidor ainda diz -10 (ex.: recusou)
    host.value.set(-5);
    fixture.detectChanges();
    expect(thumbY()).not.toBe(before);
  });

  it('teclado: setas 1 dB, PageUp 5 dB, End = -∞', () => {
    const { host, svg } = setup(-10);
    const key = (k: string) => svg.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowUp');
    key('ArrowDown');
    key('PageUp');
    key('End');
    expect(host.moves).toEqual([
      { db: -9, final: true },
      { db: -11, final: true },
      { db: -5, final: true },
      { db: -Infinity, final: true },
    ]);
  });

  it('desabilitado ou com valor desconhecido: não mexe', () => {
    const { fixture, host, svg } = setup(-10);
    host.disabled.set(true);
    fixture.detectChanges();
    pointer(svg, 'pointerdown', 200);
    pointer(svg, 'pointermove', 100);
    pointer(svg, 'pointerup', 100);
    expect(host.moves).toEqual([]);
    host.disabled.set(false);
    host.value.set(null);
    fixture.detectChanges();
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(host.moves).toEqual([]);
    expect(svg.getAttribute('aria-valuetext')).toBe('desconhecido');
  });

  it('acessível: role slider com valor e foco pelo teclado', () => {
    const { svg } = setup(-10);
    expect(svg.getAttribute('role')).toBe('slider');
    expect(svg.getAttribute('aria-valuetext')).toBe('−10.0 dB');
    expect(svg.getAttribute('tabindex')).toBe('0');
  });
});
